import b4a from 'b4a'
import { errorCode } from './error-code.js'
import fs from '#fs'
import os from '#os'
import path from '#path'
import process from '#process'
import type { FileHandle } from 'node:fs/promises'
import { SwarmDeployError, ERRORS } from './errors.js'
import { parseSeed, generateSeed, publicKeyFromSeed, parsePublicKey } from './identity.js'
import { validateReplaceNames } from './files.js'
import { compileSymlinkRules } from './symlinks.js'
import { loadHooksModule } from './hooks-module.js'
import {
  HOOK_MODE_NAMES,
  snapshotHookModes,
  type HookModes,
  type HookResponse,
  type ServerHooks
} from './hooks.js'
import { Server, type ServerLogger, type ServerOptions } from './server.js'
import { encodeLinkRequestRecord } from './tar-protocol/controls.js'
import {
  Client,
  type ClientLinkHookFailure,
  type ClientLinkResult,
  type ClientOptions,
  type ClientUploadResult
} from './client.js'
import type { DirectDhtNode } from './direct-dht.js'
import type { StorageAdapter } from './storage/types.js'
import {
  inspectStorageReset,
  resetStorage,
  METADATA_DIRECTORIES,
  type ArchiveHoldings,
  type StorageResetReport
} from './storage/reset.js'

type Env = Record<string, string | undefined>
type Output = { write(value: string): unknown }
type SignalProcess = {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
  off?(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
  removeListener?(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
}
type CliIo = {
  stdout?: Output
  stderr?: Output
  process?: SignalProcess
  Server?: new (options: ServerOptions) => Server
  Client?: new (options: ClientOptions) => Client
  dht?: DirectDhtNode
  connectTimeout?: number
  idleTimeout?: number
  /** Directory that relative `--hooks` paths resolve against; defaults to `process.cwd()`. */
  cwd?: string
  /** Storage adapter for `reset-storage`; defaults to the runtime filesystem. */
  storage?: StorageAdapter
  /** Process liveness check for `reset-storage`; defaults to a signal-0 probe. */
  isProcessAlive?: (pid: number) => boolean
  /** Lock poll interval in milliseconds for `reset-storage --wait`. */
  pollInterval?: number
}

const COMMANDS = new Set(['keygen', 'public-key', 'server', 'upload', 'link', 'reset-storage'])
const HELP_ARGS = new Set(['--help', '-h'])
const MS_PER_DAY = 24 * 60 * 60 * 1000
const MAX_SEED_FILE_BYTES = 65
const SERVER_SEED_ENV = 'SWARM_DEPLOY_SERVER_SEED'
const CLIENT_SEED_ENV = 'SWARM_DEPLOY_CLIENT_SEED'

const USAGE = [
  'Usage:',
  '  swarm-deploy keygen --out <seed-file>',
  '  swarm-deploy public-key (--seed-file <seed-file> | --seed <64-lower-hex>)',
  '  swarm-deploy server (--seed-file <seed-file> | --seed <64-lower-hex>) --storage <dir> [--state-dir <dir>] --allow-key <64-lower-hex> --max-file-bytes <bytes> --max-staging-bytes <bytes> [--allow-key <64-lower-hex>]... [--max-storage-bytes <bytes>] [--max-age-days <days>] [--replace-name <safe-basename>]... [--artifact-pattern <template>]... [--max-count <count>] [--max-versions <count> --version-granularity <major|minor>] [--symlink <selector> [<link-name>]]... [--hooks <module> [--hook-mode <afterCommit|afterLink|onFailure>=<response|detached>]...] [--initialize-state]',
  '  swarm-deploy upload (--seed-file <seed-file> | --seed <64-lower-hex>) --server-key <64-lower-hex> [--idle-timeout <milliseconds>] [--no-source-parent] [--json] <file-or-directory>',
  '  swarm-deploy link (--seed-file <seed-file> | --seed <64-lower-hex>) --server-key <64-lower-hex> [--idle-timeout <milliseconds>] [--hook-failure <rollback|keep>] [--json] <target> <link-name>',
  '  swarm-deploy reset-storage --storage <dir> [--apply [--wait <milliseconds>]] [--state-dir <dir>]',
  '',
  'Use exactly one seed source. A command-specific environment variable is also accepted.'
].join('\n')

class CliError extends Error {
  exitCode: number

  constructor(message: string, exitCode = 2) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
  }
}

function usageError(message: string): CliError {
  return new CliError(`${message}\n${USAGE}`, 2)
}

function configError(message: string): CliError {
  return new CliError(message, 2)
}

function basenameOf(value: unknown): string {
  try {
    return path.basename(String(value))
  } catch {
    return String(value)
  }
}

function isRuntime(value: unknown): boolean {
  const base = basenameOf(value)
  return base === 'node' || base === 'node.exe' || base === 'bare' || base === 'bare.exe'
}

function isScript(value: unknown): boolean {
  const base = basenameOf(value)
  return base === 'swarm-deploy' || base === 'swarm-deploy.js'
}

function normalizeArgv(argv: Iterable<string> | null | undefined): string[] {
  const args = Array.from(argv || [])
  if (args.length >= 2 && isRuntime(args[0]) && isScript(args[1])) return args.slice(2)
  if (args.length >= 1 && isScript(args[0])) return args.slice(1)
  return args
}

function platformName() {
  return os.platform()
}

function noFollowFlag() {
  if (fs.constants?.O_NOFOLLOW !== undefined) return fs.constants.O_NOFOLLOW
  const platform = platformName()
  if (platform === 'darwin') return 0x100
  if (platform === 'linux') return 0x20000
  throw configError('Safe file open is unsupported on this platform')
}

function exclusiveCreateFlag() {
  if (fs.constants?.O_EXCL !== undefined) return fs.constants.O_EXCL
  const platform = platformName()
  if (platform === 'darwin') return 0x800
  if (platform === 'linux') return 0x80
  throw configError('Safe exclusive create is unsupported on this platform')
}

function createFileFlag() {
  if (fs.constants?.O_CREAT !== undefined) return fs.constants.O_CREAT
  const platform = platformName()
  if (platform === 'darwin') return 0x200
  if (platform === 'linux') return 0x40
  throw configError('Safe exclusive create is unsupported on this platform')
}

function createSeedFlags() {
  const constants = fs.constants || {}
  return (constants.O_WRONLY ?? 1) | createFileFlag() | exclusiveCreateFlag() | noFollowFlag()
}

function readFlags() {
  return (fs.constants?.O_RDONLY ?? 0) | noFollowFlag()
}

function parsePositiveSafeInteger(value: unknown, name: string): number {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || value.length > 16) {
    throw usageError(`Invalid ${name}`)
  }
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) throw usageError(`Invalid ${name}`)
  return number
}

function parseMaxAgeDays(value: unknown): number {
  const days = parsePositiveSafeInteger(value, 'max-age-days')
  if (days > Math.floor(Number.MAX_SAFE_INTEGER / MS_PER_DAY)) {
    throw usageError('Invalid max-age-days')
  }
  return days * MS_PER_DAY
}

function envHas(env: Env, name: string): boolean {
  return !!env && Object.prototype.hasOwnProperty.call(env, name) && env[name] !== undefined
}

function parseSeedText(text: string, label: string): Buffer {
  if (typeof text !== 'string') throw configError(`Invalid ${label}`)
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  if (text !== body && text !== `${body}\n`) throw configError(`Invalid ${label}`)
  if (!/^[0-9a-f]{64}$/.test(body)) throw configError(`Invalid ${label}`)
  return parseSeed(body)
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const written = await handle.write(bytes, offset, bytes.byteLength - offset, offset)
    const count = typeof written === 'number' ? written : written.bytesWritten
    if (!Number.isSafeInteger(count) || count <= 0) throw configError('Unable to write seed file')
    offset += count
  }
}

async function readAll(handle: FileHandle, size: number): Promise<Buffer> {
  const bytes = b4a.alloc(size)
  let offset = 0
  while (offset < size) {
    const read = await handle.read(bytes, offset, size - offset, offset)
    const count = typeof read === 'number' ? read : read.bytesRead
    if (!Number.isSafeInteger(count) || count <= 0) throw configError('Unable to read file')
    offset += count
  }
  return bytes
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.promises.open(directory, 'r')
  try {
    if (typeof handle.sync === 'function') await handle.sync()
  } finally {
    await handle.close()
  }
}

async function openNoFollowRead(filePath: string, label: string): Promise<FileHandle> {
  try {
    return await fs.promises.open(filePath, readFlags())
  } catch (err) {
    if (errorCode(err) === 'ELOOP' || errorCode(err) === 'EISDIR') {
      throw configError(`${label} must be a regular file`)
    }
    throw configError(`Unable to read ${label}`)
  }
}

async function readBoundedRegularFile(
  filePath: string,
  maxBytes: number,
  label: string
): Promise<string> {
  let stat
  try {
    stat = await fs.promises.lstat(filePath)
  } catch {
    throw configError(`Unable to read ${label}`)
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw configError(`${label} must be a regular file`)
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxBytes) {
    throw configError(`Invalid ${label}`)
  }
  const handle = await openNoFollowRead(filePath, label)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size !== stat.size) throw configError(`Invalid ${label}`)
    return b4a.toString(await readAll(handle, stat.size), 'utf8')
  } finally {
    await handle.close().catch(() => {})
  }
}

async function readSeedFile(filePath: string): Promise<Buffer> {
  const text = await readBoundedRegularFile(filePath, MAX_SEED_FILE_BYTES, 'seed file')
  if (text.length < 64) throw configError('Invalid seed file')
  return parseSeedText(text, 'seed file')
}

async function removeSeedTemporary(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath)
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return
    throw configError('Unable to remove temporary seed file')
  }
  try {
    await syncDirectory(path.dirname(filePath))
  } catch {}
}

async function writeSeedFile(filePath: string, seedHex: string): Promise<void> {
  if (typeof filePath !== 'string' || filePath.length === 0) throw usageError('Missing --out')
  const directory = path.dirname(filePath)
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${b4a.toString(generateSeed(), 'hex')}.tmp`
  )
  try {
    await fs.promises.lstat(filePath)
    throw configError('Refusing to overwrite existing seed file')
  } catch (err) {
    if (err instanceof CliError) throw err
    if (errorCode(err) !== 'ENOENT') throw configError('Unable to create seed file')
  }
  let handle: FileHandle | null = null
  try {
    handle = await fs.promises.open(temporary, createSeedFlags(), 0o600)
  } catch (err) {
    throw configError('Unable to create seed file')
  }
  try {
    const opened = await handle.stat()
    if (!opened.isFile()) throw configError('Unable to create seed file')
    if (typeof handle.chmod === 'function') await handle.chmod(0o600)
    await writeAll(handle, b4a.from(`${seedHex}\n`))
    await handle.sync()
  } catch (err) {
    await handle.close().catch(() => {})
    handle = null
    await removeSeedTemporary(temporary)
    if (err instanceof CliError) throw err
    throw configError('Unable to write seed file')
  }
  await handle.close()
  handle = null
  try {
    await fs.promises.link(temporary, filePath)
    await syncDirectory(directory)
  } catch (err) {
    await removeSeedTemporary(temporary)
    if (errorCode(err) === 'EEXIST') throw configError('Refusing to overwrite existing seed file')
    throw configError('Unable to create seed file')
  }
  await removeSeedTemporary(temporary)
}

function isCanonicalHexToken(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function rejectUnexpectedSeed() {
  throw usageError('Seed strings must be passed with --seed')
}

function parseOptions(
  args: string[],
  allowed: ReadonlySet<string>,
  repeatable: ReadonlySet<string> = new Set(),
  keyValues: ReadonlySet<string> = new Set(),
  flags: ReadonlySet<string> = new Set(),
  pairs: ReadonlySet<string> = new Set(),
  allowCanonicalHexPositionals = false
): {
  options: Record<string, string | undefined>
  repeatedOptions: Record<string, string[] | undefined>
  pairOptions: Record<string, Array<[string, string | undefined]> | undefined>
  flagOptions: Record<string, true | undefined>
  positionals: string[]
} {
  const options: Record<string, string | undefined> = Object.create(null) as Record<
    string,
    string | undefined
  >
  const repeatedOptions: Record<string, string[] | undefined> = Object.create(null) as Record<
    string,
    string[] | undefined
  >
  const pairOptions: Record<string, Array<[string, string | undefined]> | undefined> =
    Object.create(null) as Record<string, Array<[string, string | undefined]> | undefined>
  const flagOptions: Record<string, true | undefined> = Object.create(null) as Record<
    string,
    true | undefined
  >
  const positionals: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (
      isCanonicalHexToken(arg) &&
      !keyValues.has(args[i - 1]) &&
      !(allowCanonicalHexPositionals && !arg.startsWith('-'))
    ) {
      rejectUnexpectedSeed()
    }
    if (arg.startsWith('-')) {
      if (arg.includes('=') || !allowed.has(arg)) throw usageError('Unknown option')
      if (
        !repeatable.has(arg) &&
        !pairs.has(arg) &&
        (Object.prototype.hasOwnProperty.call(options, arg) ||
          Object.prototype.hasOwnProperty.call(repeatedOptions, arg) ||
          Object.prototype.hasOwnProperty.call(flagOptions, arg))
      ) {
        throw usageError('Duplicate option')
      }
      // A flag takes no value, so the next argument keeps its own meaning.
      if (flags.has(arg)) {
        flagOptions[arg] = true
        continue
      }
      if (pairs.has(arg)) {
        const first = args[i + 1]
        const second = args[i + 2]
        if (first === undefined || first.startsWith('-')) {
          throw usageError('Missing option value')
        }
        const optionalSecond = second === undefined || second.startsWith('-') ? undefined : second
        if (
          optionalSecond !== undefined &&
          isCanonicalHexToken(optionalSecond) &&
          !keyValues.has(arg)
        ) {
          rejectUnexpectedSeed()
        }
        const values = pairOptions[arg] || []
        values.push([first, optionalSecond])
        pairOptions[arg] = values
        i += optionalSecond === undefined ? 1 : 2
        continue
      }
      const value = args[i + 1]
      if (value === undefined || value.startsWith('-')) {
        throw usageError('Missing option value')
      }
      if (isCanonicalHexToken(value) && !keyValues.has(arg)) rejectUnexpectedSeed()
      if (repeatable.has(arg)) {
        const values = repeatedOptions[arg] || []
        values.push(value)
        repeatedOptions[arg] = values
      } else {
        options[arg] = value
      }
      i++
      continue
    }
    positionals.push(arg)
  }
  return { options, repeatedOptions, pairOptions, flagOptions, positionals }
}

function requireOption(options: Record<string, string | undefined>, name: string): string {
  if (typeof options[name] !== 'string' || options[name].length === 0) {
    throw usageError(`Missing ${name}`)
  }
  return options[name]
}

function requirePositionals(positionals: string[], count: number, label: string): string[] {
  if (positionals.length !== count) throw usageError(label)
  return positionals
}

async function resolveSeed({
  seedFile,
  seedText,
  env,
  envName,
  role
}: {
  seedFile: string | undefined
  seedText: string | undefined
  env: Env
  envName: string
  role: string
}): Promise<Buffer> {
  const hasFile = seedFile !== undefined
  const hasText = seedText !== undefined
  const hasEnv = envHas(env, envName)
  if (Number(hasFile) + Number(hasText) + Number(hasEnv) > 1) {
    throw configError(`${role} seed must be provided by exactly one source`)
  }
  if (hasFile) return await readSeedFile(seedFile)
  if (hasText) return parseSeedText(seedText, `${role} seed`)
  if (hasEnv) return parseSeedText(String(env[envName]), `${role} seed`)
  throw usageError(`${role} seed is required`)
}

function writeLine(stream: Output | undefined, line: string): void {
  if (!stream || typeof stream.write !== 'function') return
  stream.write(line.endsWith('\n') ? line : `${line}\n`)
}

function createLogger(io: CliIo): ServerLogger {
  const write = (
    level: 'info' | 'warn' | 'error',
    message: string,
    details?: Record<string, unknown>
  ): void => {
    try {
      if (!io.stderr || typeof io.stderr.write !== 'function') return
      const suffix = details && typeof details === 'object' ? ` ${JSON.stringify(details)}` : ''
      io.stderr.write(`${level}: ${message}${suffix}\n`)
    } catch {}
  }
  return {
    info(message: string, details: Record<string, unknown>) {
      write('info', message, details)
    },
    warn(message: string, details: Record<string, unknown>) {
      write('warn', message, details)
    },
    error(message: string, details: Record<string, unknown>) {
      write('error', message, details)
    }
  }
}

function attachSignals(proc: SignalProcess | undefined, handler: () => void): () => void {
  if (!proc || typeof proc.on !== 'function') return () => {}
  proc.on('SIGINT', handler)
  proc.on('SIGTERM', handler)
  return () => {
    if (typeof proc.off === 'function') {
      proc.off('SIGINT', handler)
      proc.off('SIGTERM', handler)
      return
    }
    if (typeof proc.removeListener === 'function') {
      proc.removeListener('SIGINT', handler)
      proc.removeListener('SIGTERM', handler)
    }
  }
}

function onceClose(resource: { close(): void | Promise<void> } | null): () => Promise<void> {
  let pending: Promise<void> | null = null
  return (): Promise<void> => {
    if (!pending) {
      pending = Promise.resolve().then(() =>
        resource && typeof resource.close === 'function' ? resource.close() : undefined
      )
    }
    return pending
  }
}

function isConfigFailure(err: unknown): boolean {
  if (err instanceof CliError) return err.exitCode === 2
  if (!(err instanceof SwarmDeployError)) return false
  return (
    err.code === ERRORS.INVALID_SEED ||
    err.code === ERRORS.INVALID_PUBLIC_KEY ||
    err.code === ERRORS.PROTOCOL_INVALID ||
    err.code === ERRORS.SERVER_KEY_MISMATCH
  )
}

function exitCodeFor(err: unknown): number {
  if (
    typeof err === 'object' &&
    err !== null &&
    'exitCode' in err &&
    typeof err.exitCode === 'number'
  ) {
    return err.exitCode
  }
  return isConfigFailure(err) ? 2 : 1
}

function errorMessage(err: unknown): string {
  if (!err) return 'Unknown error'
  if (typeof err === 'object') {
    if ('message' in err && typeof err.message === 'string' && err.message.length > 0) {
      return err.message
    }
    if ('name' in err && typeof err.name === 'string' && err.name.length > 0) return err.name
  }
  return 'Error'
}

function writeError(io: CliIo, err: unknown): void {
  try {
    if (!io.stderr || typeof io.stderr.write !== 'function') return
    const message = errorMessage(err)
    io.stderr.write(message.endsWith('\n') ? message : `${message}\n`)
  } catch {}
}

async function runKeygen(args: string[]): Promise<string> {
  const { options, positionals } = parseOptions(args, new Set(['--out']))
  requirePositionals(positionals, 0, 'keygen does not accept positional arguments')
  const out = requireOption(options, '--out')
  const seed = generateSeed()
  const seedHex = b4a.toString(seed, 'hex')
  await writeSeedFile(out, seedHex)
  return b4a.toString(publicKeyFromSeed(seed), 'hex')
}

async function runPublicKey(args: string[]): Promise<string> {
  const { options, positionals } = parseOptions(
    args,
    new Set(['--seed-file', '--seed']),
    new Set(),
    new Set(['--seed'])
  )
  requirePositionals(positionals, 0, 'public-key does not accept positional arguments')
  const hasFile = options['--seed-file'] !== undefined
  const hasText = options['--seed'] !== undefined
  if (hasFile === hasText) throw usageError('public-key requires exactly one seed source')
  const seed = hasFile
    ? await readSeedFile(requireOption(options, '--seed-file'))
    : parseSeedText(requireOption(options, '--seed'), 'seed')
  return b4a.toString(publicKeyFromSeed(seed), 'hex')
}

/**
 * Parses repeated `--hook-mode <hook>=<mode>` values. Each names one post-operation
 * hook once and a mode that is exactly `response` or `detached`.
 */
function parseHookModes(values: readonly string[]): HookModes {
  const modes: Record<string, HookResponse> = Object.create(null) as Record<string, HookResponse>
  for (const value of values) {
    const at = value.indexOf('=')
    const name = at < 0 ? '' : value.slice(0, at)
    const mode = at < 0 ? '' : value.slice(at + 1)
    if (
      !(HOOK_MODE_NAMES as readonly string[]).includes(name) ||
      (mode !== 'response' && mode !== 'detached') ||
      Object.prototype.hasOwnProperty.call(modes, name)
    ) {
      throw usageError('Invalid --hook-mode')
    }
    modes[name] = mode
  }
  return { ...modes } as HookModes
}

async function runServer(args: string[], env: Env, io: CliIo): Promise<number> {
  const { options, repeatedOptions, pairOptions, flagOptions, positionals } = parseOptions(
    args,
    new Set([
      '--seed-file',
      '--seed',
      '--storage',
      '--state-dir',
      '--initialize-state',
      '--allow-key',
      '--max-file-bytes',
      '--max-staging-bytes',
      '--max-storage-bytes',
      '--max-age-days',
      '--replace-name',
      '--artifact-pattern',
      '--max-count',
      '--max-versions',
      '--version-granularity',
      '--symlink',
      '--hooks',
      '--hook-mode'
    ]),
    new Set(['--replace-name', '--allow-key', '--artifact-pattern', '--symlink', '--hook-mode']),
    new Set(['--allow-key', '--seed']),
    new Set(['--initialize-state']),
    new Set(['--symlink'])
  )
  requirePositionals(positionals, 0, 'server does not accept positional arguments')
  const storageDir = requireOption(options, '--storage')
  const stateDir = options['--state-dir']
  const initializeState = flagOptions['--initialize-state'] === true
  const maxFileBytes = parsePositiveSafeInteger(
    requireOption(options, '--max-file-bytes'),
    'max-file-bytes'
  )
  const maxStagingBytes = parsePositiveSafeInteger(
    requireOption(options, '--max-staging-bytes'),
    'max-staging-bytes'
  )
  const maxStorageBytes =
    options['--max-storage-bytes'] === undefined
      ? undefined
      : parsePositiveSafeInteger(options['--max-storage-bytes'], 'max-storage-bytes')
  const maxAge =
    options['--max-age-days'] === undefined ? undefined : parseMaxAgeDays(options['--max-age-days'])
  let replaceNames: Set<string>
  try {
    replaceNames = validateReplaceNames(repeatedOptions['--replace-name'] || [])
  } catch {
    throw usageError('Invalid --replace-name')
  }
  const artifactPatterns = repeatedOptions['--artifact-pattern']
  const maxCount =
    options['--max-count'] === undefined
      ? undefined
      : parsePositiveSafeInteger(options['--max-count'], 'max-count')
  const maxVersions =
    options['--max-versions'] === undefined
      ? undefined
      : parsePositiveSafeInteger(options['--max-versions'], 'max-versions')
  const granularity = options['--version-granularity']
  if (granularity !== undefined && granularity !== 'major' && granularity !== 'minor') {
    throw usageError('Invalid --version-granularity')
  }
  const seed = await resolveSeed({
    seedFile: options['--seed-file'],
    seedText: options['--seed'],
    env,
    envName: SERVER_SEED_ENV,
    role: 'server'
  })
  const allowedKeyValues = repeatedOptions['--allow-key'] || []
  if (allowedKeyValues.length === 0) throw usageError('Missing --allow-key')
  const allowedKeys = new Set<Buffer>()
  try {
    for (const value of allowedKeyValues) {
      const parsed = parsePublicKey(value)
      const encoded = b4a.toString(parsed, 'hex')
      if ([...allowedKeys].some((candidate) => b4a.toString(candidate, 'hex') === encoded)) {
        throw new Error('duplicate')
      }
      allowedKeys.add(parsed)
    }
  } catch {
    throw usageError('Invalid --allow-key')
  }

  const cliHookModes = parseHookModes(repeatedOptions['--hook-mode'] || [])
  let hooks: ServerHooks | undefined
  let hookModes: HookModes | undefined
  if (options['--hooks'] !== undefined) {
    try {
      const loaded = await loadHooksModule(options['--hooks'], io.cwd ?? process.cwd())
      hooks = loaded.hooks
      // The command line overrides the module's own declaration for each hook it names.
      hookModes = { ...loaded.modes, ...cliHookModes }
      snapshotHookModes(hookModes, hooks)
    } catch (err) {
      throw configError(errorMessage(err))
    }
  } else if (Object.keys(cliHookModes).length > 0) {
    throw usageError('--hook-mode requires --hooks')
  }

  const symlinkPairs = pairOptions['--symlink'] || []
  const symlinks = symlinkPairs.map(([selector, name]) =>
    name === undefined ? { selector } : { selector, name }
  )
  try {
    compileSymlinkRules(symlinks)
  } catch {
    throw usageError('Invalid --symlink')
  }

  const ServerImpl = io.Server || Server
  let server: Server
  try {
    server = new ServerImpl({
      seed,
      storageDir,
      ...(stateDir === undefined ? {} : { stateDir }),
      ...(initializeState ? { initializeState } : {}),
      allowedKeys,
      maxFileBytes,
      maxStagingBytes,
      maxStorageBytes,
      maxAge,
      replaceNames,
      artifactPatterns,
      maxCount,
      maxVersions,
      versionGranularity: granularity,
      ...(symlinks.length > 0 ? { symlinks } : {}),
      hooks,
      ...(hookModes === undefined ? {} : { hookModes }),
      dht: io.dht,
      logger: createLogger(io)
    })
  } catch (err) {
    throw new CliError(errorMessage(err), 2)
  }

  const proc = io.process || process
  const close = onceClose(server)
  let resolveStopped: () => void
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve
  })
  const onSignal = () => {
    close().then(resolveStopped, resolveStopped)
  }
  const detach = attachSignals(proc, onSignal)

  let runError = null
  try {
    try {
      await server.listen()
    } catch (err) {
      runError = new CliError(errorMessage(err), 1)
    }
    if (!runError) {
      writeLine(io.stdout, b4a.toString(server.publicKey, 'hex'))
      writeLine(io.stdout, 'ready')
      await stopped
    }
  } finally {
    detach()
    try {
      await close()
    } catch {
      if (!runError) runError = new CliError('Cleanup failed', 1)
    }
  }
  if (runError) throw runError
  return 0
}

function printUploadResult(result: ClientUploadResult, io: CliIo): number {
  writeLine(io.stdout, `${result.name} ${result.kind} ${result.status}`)
  return result.status === 'COMMITTED' || result.status === 'ALREADY_COMMITTED' ? 0 : 1
}

/** One JSON object on stdout: the upload outcome plus the hooks' own data, when any returned some. */
function printUploadJson(result: ClientUploadResult, io: CliIo): number {
  const { name, kind, status, hookResult } = result
  writeLine(
    io.stdout,
    JSON.stringify({ name, kind, status, ...(hookResult === undefined ? {} : { hookResult }) })
  )
  return status === 'COMMITTED' || status === 'ALREADY_COMMITTED' ? 0 : 1
}

/**
 * With `--json`, a failed request whose answer carried the server's `onFailure` data prints one
 * JSON object with the primary error code and that data; the exit status and the error message
 * are the same as without it. Nothing is printed when the server returned none.
 */
function printFailureJson(fields: Record<string, string>, err: unknown, io: CliIo): void {
  if (!(err instanceof SwarmDeployError) || err.hookResult === undefined) return
  writeLine(io.stdout, JSON.stringify({ ...fields, code: err.code, hookResult: err.hookResult }))
}

function printLinkResult(result: ClientLinkResult, io: CliIo): number {
  writeLine(io.stdout, `${result.name} -> ${result.target} ${result.status}`)
  return result.status === 'LINKED' || result.status === 'UNCHANGED' ? 0 : 1
}

/** One JSON object on stdout: the link outcome plus the hook's own data, when it returned any. */
function printLinkJson(result: ClientLinkResult, io: CliIo): number {
  const { target, name, status, hookResult } = result
  writeLine(
    io.stdout,
    JSON.stringify({ target, name, status, ...(hookResult === undefined ? {} : { hookResult }) })
  )
  return status === 'LINKED' || status === 'UNCHANGED' ? 0 : 1
}

function linkErrorMessage(err: unknown): string {
  if (
    err instanceof SwarmDeployError &&
    (err.code === ERRORS.LINK_NOT_ALLOWED ||
      err.code === ERRORS.LINK_TARGET_NOT_FOUND ||
      err.code === ERRORS.LINK_CONFLICT ||
      err.code === ERRORS.LINK_FAILED ||
      err.code === ERRORS.HOOK_FAILED)
  ) {
    return err.code
  }
  return errorMessage(err)
}

async function runUpload(args: string[], env: Env, io: CliIo): Promise<number> {
  const { options, flagOptions, positionals } = parseOptions(
    args,
    new Set([
      '--seed-file',
      '--seed',
      '--server-key',
      '--idle-timeout',
      '--no-source-parent',
      '--json'
    ]),
    new Set(),
    new Set(['--server-key', '--seed']),
    new Set(['--no-source-parent', '--json'])
  )
  const json = flagOptions['--json'] === true
  const [inputPath] = requirePositionals(positionals, 1, 'upload requires a file or directory')
  const seed = await resolveSeed({
    seedFile: options['--seed-file'],
    seedText: options['--seed'],
    env,
    envName: CLIENT_SEED_ENV,
    role: 'client'
  })
  let serverPublicKey: Buffer
  try {
    serverPublicKey = parsePublicKey(requireOption(options, '--server-key'))
  } catch {
    throw usageError('Invalid --server-key')
  }
  const idleTimeout =
    options['--idle-timeout'] === undefined
      ? io.idleTimeout
      : parsePositiveSafeInteger(options['--idle-timeout'], 'idle-timeout')

  const ClientImpl = io.Client || Client
  let client: Client
  try {
    client = new ClientImpl({
      seed,
      serverPublicKey,
      dht: io.dht,
      connectTimeout: io.connectTimeout,
      idleTimeout,
      ...(flagOptions['--no-source-parent'] ? { includeSourceParent: false } : {}),
      logger: createLogger(io)
    })
  } catch (err) {
    throw new CliError(errorMessage(err), 2)
  }

  const proc = io.process || process
  const close = onceClose(client)
  const detach = attachSignals(proc, () => {
    close().then(
      () => {},
      () => {}
    )
  })
  let runError = null
  let code = 0
  try {
    try {
      // Only --json asks the server for the hooks' data. It never changes whether the server
      // waits for a hook: that is the server's own declaration.
      const result = json
        ? await client.upload(inputPath, { hookResult: true })
        : await client.upload(inputPath)
      code = json ? printUploadJson(result, io) : printUploadResult(result, io)
    } catch (err) {
      if (json) printFailureJson({}, err, io)
      runError = new CliError(errorMessage(err), 1)
    }
  } finally {
    detach()
    try {
      await close()
    } catch {
      if (!runError && code === 0) runError = new CliError('Cleanup failed', 1)
    }
  }
  if (runError) throw runError
  return code
}

async function runLink(args: string[], env: Env, io: CliIo): Promise<number> {
  const { options, flagOptions, positionals } = parseOptions(
    args,
    new Set([
      '--seed-file',
      '--seed',
      '--server-key',
      '--idle-timeout',
      '--hook-failure',
      '--json'
    ]),
    new Set(),
    new Set(['--server-key', '--seed']),
    new Set(['--json']),
    new Set(),
    true
  )
  const json = flagOptions['--json'] === true
  const policy = options['--hook-failure']
  if (policy !== undefined && policy !== 'rollback' && policy !== 'keep') {
    throw usageError('Invalid --hook-failure')
  }
  const hookFailure: ClientLinkHookFailure | undefined =
    policy === 'rollback' || policy === 'keep' ? policy : undefined
  const [target, name] = requirePositionals(positionals, 2, 'link requires a target and link name')
  try {
    encodeLinkRequestRecord({ v: 1, kind: 'link', target, name })
  } catch {
    throw usageError('Invalid link target or link name')
  }
  const seed = await resolveSeed({
    seedFile: options['--seed-file'],
    seedText: options['--seed'],
    env,
    envName: CLIENT_SEED_ENV,
    role: 'client'
  })
  let serverPublicKey: Buffer
  try {
    serverPublicKey = parsePublicKey(requireOption(options, '--server-key'))
  } catch {
    throw usageError('Invalid --server-key')
  }
  const clientSeedHex = b4a.toString(seed, 'hex')
  const serverKeyHex = b4a.toString(serverPublicKey, 'hex')
  if (
    target === clientSeedHex ||
    target === serverKeyHex ||
    name === clientSeedHex ||
    name === serverKeyHex
  ) {
    throw usageError('Invalid link target or link name')
  }
  const idleTimeout =
    options['--idle-timeout'] === undefined
      ? io.idleTimeout
      : parsePositiveSafeInteger(options['--idle-timeout'], 'idle-timeout')

  const ClientImpl = io.Client || Client
  let client: Client
  try {
    client = new ClientImpl({
      seed,
      serverPublicKey,
      dht: io.dht,
      connectTimeout: io.connectTimeout,
      idleTimeout,
      logger: createLogger(io)
    })
  } catch (err) {
    throw new CliError(errorMessage(err), 2)
  }

  const proc = io.process || process
  const close = onceClose(client)
  const detach = attachSignals(proc, () => {
    close().then(
      () => {},
      () => {}
    )
  })
  let runError = null
  let code = 0
  try {
    try {
      // Only --json asks the server for the hook's result, and only --hook-failure names a
      // policy; the client sends its own default (rollback), so the plain call is two arguments.
      const asked = {
        ...(hookFailure === undefined ? {} : { hookFailure }),
        ...(json ? { hookResult: true } : {})
      }
      const result =
        Object.keys(asked).length === 0
          ? await client.link(target, name)
          : await client.link(target, name, asked)
      code = json ? printLinkJson(result, io) : printLinkResult(result, io)
    } catch (err) {
      if (json) printFailureJson({ target, name }, err, io)
      runError = new CliError(linkErrorMessage(err), 1)
    }
  } finally {
    detach()
    try {
      await close()
    } catch {
      if (!runError && code === 0) runError = new CliError('Cleanup failed', 1)
    }
  }
  if (runError) throw runError
  return code
}

const RESET_LIST_LIMIT = 10

function listNames(names: string[]): string {
  if (names.length === 0) return ''
  const shown = names.slice(0, RESET_LIST_LIMIT).join(', ')
  const more = names.length - RESET_LIST_LIMIT
  return ` (${shown}${more > 0 ? `, and ${more} more` : ''})`
}

function formatLockState(lock: StorageResetReport['lock']): string {
  const age = (ms: number) => `${Math.round(ms / 1000)}s`
  if (lock.status === 'free') return 'free'
  if (lock.status === 'held') return `held by pid ${lock.pid} (lock age ${age(lock.ageMs)})`
  if (lock.status === 'stale') {
    return `stale, pid ${lock.pid} is not running (lock age ${age(lock.ageMs)}); will be retired`
  }
  if (lock.status === 'malformed') {
    return 'unreadable; reset refused until the server is stopped and its lock reconciled'
  }
  return 'unsafe path; the reset refuses to proceed'
}

/** Names the metadata directories an archive holds and counts its lock residue entries. */
function describeHoldings(held: ArchiveHoldings): string {
  const parts = [...held.directories]
  if (held.lockEntries > 0) {
    parts.push(`${held.lockEntries} lock residue ${held.lockEntries === 1 ? 'entry' : 'entries'}`)
  }
  return parts.length > 0 ? parts.join(', ') : 'nothing'
}

/** One `key: value` line per fact, so operators and scripts can read the same output. */
function formatResetReport(report: StorageResetReport): string[] {
  const lines = [
    `storage: ${report.root}`,
    `state: ${report.state}`,
    `lock: ${formatLockState(report.lock)}`
  ]
  if (report.resetPending) {
    const archive =
      report.pendingArchive === null ? '' : ` (resumes archive ${report.pendingArchive})`
    lines.push(
      `reset pending: yes${archive}; server startup is blocked until reset-storage --apply finishes`
    )
  }
  const commitDetails: string[] = []
  if (report.commits.missingPayloads.length > 0) {
    commitDetails.push(`${report.commits.missingPayloads.length} missing payloads`)
  }
  if (report.commits.invalid > 0) commitDetails.push(`${report.commits.invalid} invalid`)
  lines.push(
    `commits: ${report.commits.records} records${commitDetails.length ? ` (${commitDetails.join(', ')})` : ''}`
  )
  for (const name of METADATA_DIRECTORIES) {
    if (name === 'commits') continue
    if (name === 'links') {
      const invalid = report.links.invalid > 0 ? ` (${report.links.invalid} invalid)` : ''
      lines.push(`links: ${report.links.records} records${invalid}`)
      continue
    }
    lines.push(`${name}: ${report.metadata[name]} entries`)
  }
  lines.push(`obsolete locks: ${report.obsoleteLocks}`)
  const interrupted = report.archives.filter((archive) => archive.status !== 'completed').length
  lines.push(
    `archives: ${report.archives.length}${interrupted ? ` (${interrupted} interrupted)` : ''}`
  )
  // An interrupted marker can lag the archive, so name what it physically holds.
  for (const archive of report.archives) {
    if (archive.status === 'completed') continue
    lines.push(`interrupted archive: ${archive.name} holds ${describeHoldings(archive.held)}`)
  }
  if (report.unknownInternal.length > 0) {
    lines.push(
      `unknown internal entries: ${report.unknownInternal.length}${listNames(report.unknownInternal)}; left in place`
    )
  }
  const { payloads, symlinks, other } = report.remaining
  lines.push(`remaining payloads: ${payloads.length}${listNames(payloads)}`)
  lines.push(`remaining symlinks: ${symlinks.length}${listNames(symlinks)}`)
  if (other.length > 0) lines.push(`remaining other entries: ${other.length}${listNames(other)}`)
  lines.push(`fresh start: ${report.freshStart ? 'yes' : 'no'}`)
  if (payloads.length > 0) {
    lines.push(
      'note: remaining payloads keep their names occupied; uploading the same name returns FILE_EXISTS until you remove them manually'
    )
  }
  if (symlinks.length > 0) {
    lines.push(
      'note: remaining symlinks have no ownership record after the reset; an automatic --symlink rule for that name fails closed with LINK_CONFLICT until you remove them manually, while an explicit link request replaces them'
    )
  }
  if (other.length > 0) {
    lines.push('note: remaining other entries are unmanaged and keep their names occupied')
  }
  if (report.applied) {
    if (report.resumed !== null) {
      lines.push(
        `resumed: yes; the interrupted archive already held ${describeHoldings(report.resumed)}`
      )
    }
    lines.push(`archive: ${report.archive}`)
    lines.push('result: metadata archived; the next server start begins with empty metadata')
  } else {
    lines.push(
      'result: preview only, nothing changed; re-run with --apply to archive this metadata'
    )
  }
  return lines
}

async function runResetStorage(args: string[], io: CliIo): Promise<number> {
  const { options, flagOptions, positionals } = parseOptions(
    args,
    new Set(['--storage', '--state-dir', '--apply', '--wait']),
    new Set(),
    new Set(),
    new Set(['--apply'])
  )
  requirePositionals(positionals, 0, 'reset-storage does not accept positional arguments')
  const storageDir = requireOption(options, '--storage')
  const stateDir = options['--state-dir']
  const apply = flagOptions['--apply'] === true
  if (!apply && options['--wait'] !== undefined) {
    throw usageError('--wait requires --apply')
  }
  const wait =
    options['--wait'] === undefined ? 0 : parsePositiveSafeInteger(options['--wait'], 'wait')
  const resetOptions = {
    storageDir,
    ...(stateDir === undefined ? {} : { stateDir }),
    wait,
    storage: io.storage,
    isProcessAlive: io.isProcessAlive,
    pollInterval: io.pollInterval
  }
  let report: StorageResetReport
  try {
    report = apply ? await resetStorage(resetOptions) : await inspectStorageReset(resetOptions)
  } catch (err) {
    throw new CliError(errorMessage(err), exitCodeFor(err))
  }
  for (const line of formatResetReport(report)) writeLine(io.stdout, line)
  return 0
}

async function dispatch(argv: string[], env: Env, io: CliIo): Promise<number> {
  if (argv.length === 1 && HELP_ARGS.has(argv[0])) {
    writeLine(io.stdout, USAGE)
    return 0
  }
  if (argv.length === 0) throw usageError('Missing command')
  const command = argv[0]
  if (isCanonicalHexToken(command)) rejectUnexpectedSeed()
  if (!COMMANDS.has(command)) throw usageError('Unknown command')
  const args = argv.slice(1)
  if (command === 'keygen') {
    writeLine(io.stdout, await runKeygen(args))
    return 0
  }
  if (command === 'public-key') {
    writeLine(io.stdout, await runPublicKey(args))
    return 0
  }
  if (command === 'server') return runServer(args, env, io)
  if (command === 'upload') return runUpload(args, env, io)
  if (command === 'reset-storage') return runResetStorage(args, io)
  return runLink(args, env, io)
}

async function main(
  argv: Iterable<string> | null | undefined,
  env: Env,
  io: CliIo = {}
): Promise<number> {
  const streams = {
    stdout: io.stdout || process.stdout,
    stderr: io.stderr || process.stderr
  }
  const context = { ...io, ...streams }
  try {
    return await dispatch(normalizeArgv(argv), env || {}, context)
  } catch (err) {
    writeError(context, err)
    return exitCodeFor(err)
  }
}

export { main, USAGE }

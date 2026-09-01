'use strict'

const b4a = require('b4a')
const fs = require('#fs')
const path = require('#path')
const process = require('#process')
const { SwarmDeployError, ERRORS } = require('./errors')
const { parseSeed, parsePublicKey, generateSeed, publicKeyFromSeed } = require('./identity')
const { parseAllowlist } = require('./allowlist')
const { Server, fingerprint } = require('./server')
const { Client } = require('./client')

const COMMANDS = new Set(['keygen', 'public-key', 'server', 'upload'])
const HELP_ARGS = new Set(['--help', '-h'])
const MS_PER_DAY = 24 * 60 * 60 * 1000
const MAX_SEED_FILE_BYTES = 65
const MAX_ALLOWLIST_BYTES = 1024 * 1024
const SERVER_SEED_ENV = 'SWARM_DEPLOY_SERVER_SEED'
const CLIENT_SEED_ENV = 'SWARM_DEPLOY_CLIENT_SEED'

const USAGE = [
  'Usage:',
  '  swarm-deploy keygen --out <seed-file>',
  '  swarm-deploy public-key --seed-file <seed-file>',
  '  swarm-deploy server --seed-file <seed-file> --storage <dir> --allowlist <file> --max-file-bytes <bytes> --max-staging-bytes <bytes> [--max-storage-bytes <bytes>] [--max-age-days <days>]',
  '  swarm-deploy upload --seed-file <seed-file> --server-key <64-lower-hex> <file-or-directory>',
  '',
  'Use --seed-file. A command-specific environment variable is also accepted.'
].join('\n')

class CliError extends Error {
  constructor(message, exitCode = 2) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
  }
}

function usageError(message) {
  return new CliError(`${message}\n${USAGE}`, 2)
}

function configError(message) {
  return new CliError(message, 2)
}

function basenameOf(value) {
  try {
    return path.basename(value)
  } catch {
    return String(value)
  }
}

function isRuntime(value) {
  const base = basenameOf(value)
  return base === 'node' || base === 'node.exe' || base === 'bare' || base === 'bare.exe'
}

function isScript(value) {
  const base = basenameOf(value)
  return base === 'swarm-deploy' || base === 'swarm-deploy.js'
}

function normalizeArgv(argv) {
  const args = Array.from(argv || [])
  if (args.length >= 2 && isRuntime(args[0]) && isScript(args[1])) return args.slice(2)
  if (args.length >= 1 && isScript(args[0])) return args.slice(1)
  return args
}

function platformName() {
  if (typeof Bare !== 'undefined') return require('bare-os').platform()
  return require('os').platform()
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

function parsePositiveSafeInteger(value, name) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || value.length > 16) {
    throw usageError(`Invalid ${name}`)
  }
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) throw usageError(`Invalid ${name}`)
  return number
}

function parseMaxAgeDays(value) {
  const days = parsePositiveSafeInteger(value, 'max-age-days')
  if (days > Math.floor(Number.MAX_SAFE_INTEGER / MS_PER_DAY)) {
    throw usageError('Invalid max-age-days')
  }
  return days * MS_PER_DAY
}

function envHas(env, name) {
  return !!env && Object.prototype.hasOwnProperty.call(env, name) && env[name] !== undefined
}

function parseSeedText(text, label) {
  if (typeof text !== 'string') throw configError(`Invalid ${label}`)
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  if (text !== body && text !== `${body}\n`) throw configError(`Invalid ${label}`)
  if (!/^[0-9a-f]{64}$/.test(body)) throw configError(`Invalid ${label}`)
  return parseSeed(body)
}

async function writeAll(handle, bytes) {
  let offset = 0
  while (offset < bytes.byteLength) {
    const written = await handle.write(bytes, offset, bytes.byteLength - offset, offset)
    const count = typeof written === 'number' ? written : written.bytesWritten
    if (!Number.isSafeInteger(count) || count <= 0) throw configError('Unable to write seed file')
    offset += count
  }
}

async function readAll(handle, size) {
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

async function syncDirectory(directory) {
  const handle = await fs.promises.open(directory, 'r')
  try {
    if (typeof handle.sync === 'function') await handle.sync()
  } finally {
    await handle.close()
  }
}

async function openNoFollowRead(filePath, label) {
  try {
    return await fs.promises.open(filePath, readFlags())
  } catch (err) {
    if (err && (err.code === 'ELOOP' || err.code === 'EISDIR')) {
      throw configError(`${label} must be a regular file`)
    }
    throw configError(`Unable to read ${label}`)
  }
}

async function readBoundedRegularFile(filePath, maxBytes, label) {
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

async function readSeedFile(filePath) {
  const text = await readBoundedRegularFile(filePath, MAX_SEED_FILE_BYTES, 'seed file')
  if (text.length < 64) throw configError('Invalid seed file')
  return parseSeedText(text, 'seed file')
}

function sameFileIdentity(left, right) {
  return (
    !!left &&
    !!right &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    (typeof left.dev === 'number' || typeof left.dev === 'bigint') &&
    (typeof left.ino === 'number' || typeof left.ino === 'bigint')
  )
}

async function unlinkOwnedSeedFile(filePath, identity) {
  if (!identity) return
  try {
    const current = await fs.promises.lstat(filePath)
    if (current.isSymbolicLink() || !current.isFile()) return
    if (!sameFileIdentity(current, identity)) return
    await fs.promises.unlink(filePath)
    try {
      await syncDirectory(path.dirname(filePath))
    } catch {}
  } catch {}
}

async function writeSeedFile(filePath, seedHex) {
  if (typeof filePath !== 'string' || filePath.length === 0) throw usageError('Missing --out')
  try {
    await fs.promises.lstat(filePath)
    throw configError('Refusing to overwrite existing seed file')
  } catch (err) {
    if (err instanceof CliError) throw err
    if (!err || err.code !== 'ENOENT') throw configError('Unable to create seed file')
  }
  let handle = null
  let identity = null
  try {
    handle = await fs.promises.open(filePath, createSeedFlags(), 0o600)
  } catch (err) {
    if (err && err.code === 'EEXIST') throw configError('Refusing to overwrite existing seed file')
    throw configError('Unable to create seed file')
  }
  try {
    const opened = await handle.stat()
    if (!opened.isFile()) throw configError('Unable to create seed file')
    identity = { dev: opened.dev, ino: opened.ino }
    if (typeof handle.chmod === 'function') await handle.chmod(0o600)
    await writeAll(handle, b4a.from(`${seedHex}\n`))
    await handle.sync()
  } catch (err) {
    await handle.close().catch(() => {})
    handle = null
    await unlinkOwnedSeedFile(filePath, identity)
    if (err instanceof CliError) throw err
    throw configError('Unable to write seed file')
  }
  await handle.close()
  try {
    await syncDirectory(path.dirname(filePath))
  } catch {}
}

function isCanonicalHexToken(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function isRawSeedOption(arg) {
  if (typeof arg !== 'string') return false
  if (arg === '--seed-file' || arg.startsWith('--seed-file=')) return false
  return arg === '--seed' || arg.startsWith('--seed')
}

function rejectRawSeed() {
  throw usageError('Raw seeds are not accepted as command-line arguments')
}

function parseOptions(args, allowed) {
  const options = Object.create(null)
  const positionals = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (isRawSeedOption(arg) || isCanonicalHexToken(arg)) rejectRawSeed()
    if (arg.startsWith('-')) {
      if (arg.includes('=') || !allowed.has(arg)) throw usageError('Unknown option')
      if (Object.prototype.hasOwnProperty.call(options, arg)) throw usageError('Duplicate option')
      const value = args[i + 1]
      if (value === undefined || value.startsWith('-')) {
        if (value !== undefined && (isRawSeedOption(value) || isCanonicalHexToken(value))) {
          rejectRawSeed()
        }
        throw usageError('Missing option value')
      }
      options[arg] = value
      i++
      continue
    }
    positionals.push(arg)
  }
  return { options, positionals }
}

function requireOption(options, name) {
  if (typeof options[name] !== 'string' || options[name].length === 0) {
    throw usageError(`Missing ${name}`)
  }
  return options[name]
}

function requirePositionals(positionals, count, label) {
  if (positionals.length !== count) throw usageError(label)
  return positionals
}

async function resolveSeed({ seedFile, env, envName, role }) {
  const hasFile = seedFile !== undefined
  const hasEnv = envHas(env, envName)
  if (hasFile && hasEnv) {
    throw configError(`${role} seed cannot be provided by both file and environment`)
  }
  if (hasFile) return await readSeedFile(seedFile)
  if (hasEnv) return parseSeedText(String(env[envName]), `${role} seed`)
  throw usageError(`${role} seed is required`)
}

function writeLine(stream, line) {
  if (!stream || typeof stream.write !== 'function') return
  stream.write(line.endsWith('\n') ? line : `${line}\n`)
}

function createLogger(io) {
  const write = (level, message, details) => {
    try {
      if (!io.stderr || typeof io.stderr.write !== 'function') return
      const suffix = details && typeof details === 'object' ? ` ${JSON.stringify(details)}` : ''
      io.stderr.write(`${level}: ${message}${suffix}\n`)
    } catch {}
  }
  return {
    info(message, details) {
      write('info', message, details)
    },
    warn(message, details) {
      write('warn', message, details)
    },
    error(message, details) {
      write('error', message, details)
    }
  }
}

function attachSignals(proc, handler) {
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

function onceClose(resource) {
  let pending = null
  return () => {
    if (!pending) {
      pending = Promise.resolve().then(() =>
        resource && typeof resource.close === 'function' ? resource.close() : undefined
      )
    }
    return pending
  }
}

function isConfigFailure(err) {
  if (err instanceof CliError) return err.exitCode === 2
  if (!(err instanceof SwarmDeployError)) return false
  return (
    err.code === ERRORS.INVALID_SEED ||
    err.code === ERRORS.INVALID_PUBLIC_KEY ||
    err.code === ERRORS.PROTOCOL_INVALID ||
    err.code === ERRORS.SERVER_KEY_MISMATCH
  )
}

function exitCodeFor(err) {
  if (typeof err?.exitCode === 'number') return err.exitCode
  return isConfigFailure(err) ? 2 : 1
}

function errorMessage(err) {
  if (!err) return 'Unknown error'
  if (typeof err.message === 'string' && err.message.length > 0) return err.message
  return err.name || 'Error'
}

function writeError(io, err) {
  try {
    if (!io.stderr || typeof io.stderr.write !== 'function') return
    const message = errorMessage(err)
    io.stderr.write(message.endsWith('\n') ? message : `${message}\n`)
  } catch {}
}

async function runKeygen(args) {
  const { options, positionals } = parseOptions(args, new Set(['--out']))
  requirePositionals(positionals, 0, 'keygen does not accept positional arguments')
  const out = requireOption(options, '--out')
  const seed = generateSeed()
  const seedHex = b4a.toString(seed, 'hex')
  await writeSeedFile(out, seedHex)
  return b4a.toString(publicKeyFromSeed(seed), 'hex')
}

async function runPublicKey(args) {
  const { options, positionals } = parseOptions(args, new Set(['--seed-file']))
  requirePositionals(positionals, 0, 'public-key does not accept positional arguments')
  const seed = await readSeedFile(requireOption(options, '--seed-file'))
  return b4a.toString(publicKeyFromSeed(seed), 'hex')
}

async function runServer(args, env, io) {
  const { options, positionals } = parseOptions(
    args,
    new Set([
      '--seed-file',
      '--storage',
      '--allowlist',
      '--max-file-bytes',
      '--max-staging-bytes',
      '--max-storage-bytes',
      '--max-age-days'
    ])
  )
  requirePositionals(positionals, 0, 'server does not accept positional arguments')
  const storageDir = requireOption(options, '--storage')
  const allowlistPath = requireOption(options, '--allowlist')
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
  const seed = await resolveSeed({
    seedFile: options['--seed-file'],
    env,
    envName: SERVER_SEED_ENV,
    role: 'server'
  })
  const allowlistText = await readBoundedRegularFile(
    allowlistPath,
    MAX_ALLOWLIST_BYTES,
    'allowlist'
  )
  let allowedKeys
  try {
    allowedKeys = parseAllowlist(allowlistText)
  } catch {
    throw configError('Invalid allowlist')
  }

  const ServerImpl = io.Server || Server
  let server
  try {
    server = new ServerImpl({
      seed,
      storageDir,
      allowedKeys,
      allowlistPath,
      maxFileBytes,
      maxStagingBytes,
      maxStorageBytes,
      maxAge,
      dht: io.dht,
      swarmFactory: io.swarmFactory,
      logger: createLogger(io)
    })
  } catch (err) {
    throw new CliError(errorMessage(err), 2)
  }

  const proc = io.process || process
  const close = onceClose(server)
  let resolveStopped
  const stopped = new Promise((resolve) => {
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
      runError = new CliError(errorMessage(err), isConfigFailure(err) ? 2 : 1)
    }
    if (!runError) {
      writeLine(io.stdout, b4a.toString(server.publicKey, 'hex'))
      writeLine(io.stdout, fingerprint(server.topic))
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

function printUploadResult(result, io) {
  if (result && Array.isArray(result.results)) {
    for (const skipped of result.skipped || []) {
      writeLine(io.stdout, `${skipped.name} skipped ${skipped.reason}`)
    }
    let failed = false
    for (const entry of result.results) {
      writeLine(io.stdout, `${entry.name} ${entry.status}`)
      if (entry.status !== 'COMMITTED' && entry.status !== 'ALREADY_COMMITTED') failed = true
    }
    return failed ? 1 : 0
  }
  const name = result?.name || 'upload'
  writeLine(io.stdout, `${name} ${result?.status || 'FAILED'}`)
  return result?.status === 'COMMITTED' || result?.status === 'ALREADY_COMMITTED' ? 0 : 1
}

async function runUpload(args, env, io) {
  const { options, positionals } = parseOptions(args, new Set(['--seed-file', '--server-key']))
  const [inputPath] = requirePositionals(positionals, 1, 'upload requires a file or directory')
  const seed = await resolveSeed({
    seedFile: options['--seed-file'],
    env,
    envName: CLIENT_SEED_ENV,
    role: 'client'
  })
  let serverPublicKey
  try {
    serverPublicKey = parsePublicKey(requireOption(options, '--server-key'))
  } catch {
    throw usageError('Invalid --server-key')
  }

  const ClientImpl = io.Client || Client
  let client
  try {
    client = new ClientImpl({
      seed,
      serverPublicKey,
      dht: io.dht,
      connectTimeout: io.connectTimeout,
      idleTimeout: io.idleTimeout,
      swarmFactory: io.swarmFactory,
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
      const result = await client.upload(inputPath)
      code = printUploadResult(result, io)
    } catch (err) {
      runError = new CliError(errorMessage(err), isConfigFailure(err) ? 2 : 1)
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

async function dispatch(argv, env, io) {
  if (argv.length === 1 && HELP_ARGS.has(argv[0])) {
    writeLine(io.stdout, USAGE)
    return 0
  }
  if (argv.length === 0) throw usageError('Missing command')
  const command = argv[0]
  if (isRawSeedOption(command) || isCanonicalHexToken(command)) rejectRawSeed()
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
  return runUpload(args, env, io)
}

async function main(argv, env, io = {}) {
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

module.exports = {
  main,
  USAGE
}

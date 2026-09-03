import fs from 'node:fs'

const tag = process.env.GITHUB_REF_NAME || ''
const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const expected = `v${packageJson.version}`

if (!/^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(tag)) {
  console.error(`Invalid release tag: ${JSON.stringify(tag)}`)
  process.exitCode = 1
} else if (tag !== expected) {
  console.error(`Release tag ${tag} does not match package version ${packageJson.version}`)
  process.exitCode = 1
} else {
  console.log(`Release tag ${tag} matches package version`)
}

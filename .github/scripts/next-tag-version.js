const { execFileSync } = require('node:child_process')

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/
const RELATIVE_BUMPS = new Set(['patch', 'minor', 'major'])

function parse(version) {
  const match = SEMVER.exec(version)
  if (match === null) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ?? null }
}

function compare(left, right) {
  for (const part of ['major', 'minor', 'patch']) {
    if (left[part] !== right[part]) return left[part] - right[part]
  }
  if (left.prerelease === right.prerelease) return 0
  if (left.prerelease === null) return 1
  if (right.prerelease === null) return -1
  return left.prerelease < right.prerelease ? -1 : 1
}

function latestTaggedRelease(tagPrefix) {
  const tags = execFileSync('git', ['tag', '--list', `${tagPrefix}v*`], { encoding: 'utf8' }).split('\n')
  let latest = null
  for (const tag of tags) {
    const version = parse(tag.slice(tagPrefix.length + 1))
    if (version === null || version.prerelease !== null) continue
    if (latest === null || compare(version, latest) > 0) latest = version
  }
  return latest
}

function bumped(latest, bump) {
  const base = latest ?? { major: 0, minor: 0, patch: 0 }
  if (bump === 'major') return `${base.major + 1}.0.0`
  if (bump === 'minor') return `${base.major}.${base.minor + 1}.0`
  if (latest === null) return '0.1.0'
  return `${base.major}.${base.minor}.${base.patch + 1}`
}

function main() {
  const [tagPrefix, input] = process.argv.slice(2)
  if (tagPrefix === undefined || input === undefined) {
    console.error('Usage: next-tag-version.js <tag prefix> <patch|minor|major|explicit version>')
    process.exit(1)
  }
  const latest = latestTaggedRelease(tagPrefix)
  if (RELATIVE_BUMPS.has(input)) {
    process.stdout.write(bumped(latest, input))
    return
  }
  const explicit = parse(input)
  if (explicit === null) {
    console.error(`'${input}' is neither patch, minor, major, nor a version such as 1.2.3`)
    process.exit(1)
  }
  if (latest !== null && compare(explicit, latest) <= 0) {
    console.error(
      `${input} is not newer than the latest tagged release ${latest.major}.${latest.minor}.${latest.patch}`,
    )
    process.exit(1)
  }
  process.stdout.write(input)
}

main()

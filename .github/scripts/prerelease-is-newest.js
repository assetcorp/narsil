const { execFileSync } = require('node:child_process')
const { appendFileSync, readFileSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

const LIBRARY_PACKAGE = '@delali/narsil'
const REACT_NATIVE_PACKAGE = '@delali/narsil-react-native'
const PLATFORM_PACKAGES_DIRECTORY = join('packages', 'native', 'npm')
const NEXT_DIST_TAG = 'next'
const UNPUBLISHED_PACKAGE_ERROR_CODE = 'E404'
const PRERELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-next\.(\d+))?$/

const parse = version => {
  const match = PRERELEASE_VERSION.exec(version)
  if (match === null) throw new Error(`Cannot read "${version}" as major.minor.patch or major.minor.patch-next.<run>`)
  const [major, minor, patch] = match.slice(1, 4).map(Number)
  const run = match[4] === undefined ? Number.POSITIVE_INFINITY : Number(match[4])
  return [major, minor, patch, run]
}

const isNewer = (candidate, current) => {
  const left = parse(candidate)
  const right = parse(current)
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index]
  }
  return false
}

const packagesToPublish = () => [
  LIBRARY_PACKAGE,
  REACT_NATIVE_PACKAGE,
  ...readdirSync(PLATFORM_PACKAGES_DIRECTORY).map(platform => {
    const manifest = JSON.parse(readFileSync(join(PLATFORM_PACKAGES_DIRECTORY, platform, 'package.json'), 'utf8'))
    return manifest.name
  }),
]

const registryErrorCode = error => {
  try {
    return JSON.parse(String(error.stdout ?? '')).error?.code
  } catch {
    return undefined
  }
}

const nextTagOf = packageName => {
  let listing
  try {
    listing = execFileSync('npm', ['view', packageName, 'dist-tags', '--json', '--prefer-online'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    if (registryErrorCode(error) === UNPUBLISHED_PACKAGE_ERROR_CODE) return undefined
    throw error
  }
  const current = JSON.parse(listing)[NEXT_DIST_TAG]
  return typeof current === 'string' && current !== '' ? current : undefined
}

const writeOutput = (key, value) => {
  console.log(`${key}=${value}`)
  const target = process.env.GITHUB_OUTPUT
  if (target !== undefined) appendFileSync(target, `${key}=${value}\n`)
}

const main = () => {
  const [candidate] = process.argv.slice(2)
  if (candidate === undefined || candidate === '') {
    console.error('Usage: prerelease-is-newest.js <prerelease version>')
    process.exit(2)
  }
  parse(candidate)

  for (const packageName of packagesToPublish()) {
    const current = nextTagOf(packageName)
    if (current === undefined) {
      console.log(`${packageName} has no ${NEXT_DIST_TAG} dist-tag yet.`)
      continue
    }
    if (isNewer(current, candidate)) {
      console.log(`${packageName} has ${current} under ${NEXT_DIST_TAG}, newer than ${candidate}, so publishing stops.`)
      writeOutput('newest', 'false')
      return
    }
  }
  console.log(`${candidate} is at least as new as every ${NEXT_DIST_TAG} dist-tag, so publishing can continue.`)
  writeOutput('newest', 'true')
}

main()

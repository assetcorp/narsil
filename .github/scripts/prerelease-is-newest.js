const { execFileSync } = require('node:child_process')
const { appendFileSync } = require('node:fs')

const LIBRARY_PACKAGE = '@delali/narsil'
const NEXT_DIST_TAG = 'next'
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

  const current = execFileSync('npm', ['view', LIBRARY_PACKAGE, `dist-tags.${NEXT_DIST_TAG}`, '--prefer-online'], {
    encoding: 'utf8',
  }).trim()

  if (current === '') {
    console.log(`${LIBRARY_PACKAGE} has no ${NEXT_DIST_TAG} dist-tag yet, so ${candidate} takes it.`)
    writeOutput('newest', 'true')
    return
  }
  if (!isNewer(current, candidate)) {
    console.log(`${candidate} is at least as new as ${current} under ${NEXT_DIST_TAG}, so publishing can continue.`)
    writeOutput('newest', 'true')
    return
  }
  console.log(`${NEXT_DIST_TAG} already holds ${current}, newer than ${candidate}, so nothing is published.`)
  writeOutput('newest', 'false')
}

main()

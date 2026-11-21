const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')

const CRATES_INDEX_URL = 'https://index.crates.io'
const CRATES_IO_SOURCES = new Set([
  'registry+https://github.com/rust-lang/crates.io-index',
  'sparse+https://index.crates.io/',
])
const CARGO_LOCKFILE_PATTERN = /(^|\/)Cargo\.lock$/
const CRATE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const GIT_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024

const addedCargoCrates = (baseRef, readBaseFile) => {
  const currentCrates = parseCargoLockfiles(trackedCargoLockfiles().map(path => readFileSync(path, 'utf8')))
  const baseCrates = parseCargoLockfiles(baseCargoLockfiles(baseRef).map(path => readBaseFile(baseRef, path)))

  return [...currentCrates.entries()].filter(([identity]) => !baseCrates.has(identity)).map(([, crate]) => crate)
}

const isCratesIoSource = source => CRATES_IO_SOURCES.has(source)

const crateIndexEntries = async (name, cache, fetchBody) => {
  if (cache.has(name)) {
    return cache.get(name)
  }

  if (!CRATE_NAME_PATTERN.test(name)) {
    throw new Error(`'${name}' is not a valid crate name`)
  }

  const body = await fetchBody(`${CRATES_INDEX_URL}/${sparseIndexPath(name)}`, 'text/plain', 'crates.io index')
  const entries = body
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line))
  cache.set(name, entries)

  return entries
}

const sparseIndexPath = name => {
  const lowered = name.toLowerCase()

  if (lowered.length <= 2) {
    return `${lowered.length}/${lowered}`
  }

  if (lowered.length === 3) {
    return `3/${lowered[0]}/${lowered}`
  }

  return `${lowered.slice(0, 2)}/${lowered.slice(2, 4)}/${lowered}`
}

const cargoLockfilesListed = args =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: GIT_OUTPUT_LIMIT_BYTES })
    .split('\0')
    .filter(path => CARGO_LOCKFILE_PATTERN.test(path))

const trackedCargoLockfiles = () => cargoLockfilesListed(['ls-files', '-z'])

const baseCargoLockfiles = baseRef => cargoLockfilesListed(['ls-tree', '-r', '-z', '--name-only', baseRef])

const parseCargoLockfiles = contents => {
  const crates = new Map()

  for (const content of contents) {
    for (const crate of parseCargoLock(content)) {
      crates.set(JSON.stringify([crate.name, crate.version, crate.source]), crate)
    }
  }

  return crates
}

const parseCargoLock = content => {
  const crates = []
  let entry

  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith('[')) {
      if (entry?.source !== undefined) crates.push(entry)
      entry = line.trim() === '[[package]]' ? {} : undefined
      continue
    }

    const field = entry === undefined ? null : line.match(/^(name|version|source) = "([^"\\]*)"$/)

    if (field) {
      entry[field[1]] = field[2]
    }
  }

  if (entry?.source !== undefined) crates.push(entry)

  return crates
}

module.exports = { GIT_OUTPUT_LIMIT_BYTES, addedCargoCrates, crateIndexEntries, isCratesIoSource }

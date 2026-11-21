const { execFileSync } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const { GIT_OUTPUT_LIMIT_BYTES, addedCargoCrates, crateIndexEntries, isCratesIoSource } = require('./age-gate-cargo.js')

const DAY_MS = 24 * 60 * 60 * 1000
const LOCKFILE = 'pnpm-lock.yaml'
const REGISTRY_URL = 'https://registry.npmjs.org'
const EXEMPTIONS_FILE = '.github/scripts/dependency-age-exemptions.json'
const FETCH_TIMEOUT_MS = 10_000
const USER_AGENT = 'narsil-dependency-age-gate (https://github.com/assetcorp/narsil)'

// uWebSockets.js is published only through GitHub, never the npm registry, so it
// has no registry publish date to gate on; the supply-chain gate verifies its pin.
const ALLOWED_URL_DEPENDENCIES = new Set(['uWebSockets.js'])

const AGE_EXEMPT_PACKAGES = new Set(['@delali/sirannon-db'])

const isUrlSourcedVersion = version => /^(https?:|git:|git\+|github:)/.test(version)

const minAgeDays = parsePositiveInteger(process.env.MIN_AGE_DAYS || '4')
const minimumPublishedAt = Date.now() - minAgeDays * DAY_MS

const main = async () => {
  const baseRef = resolveBaseRef()
  const exemptions = readExemptions()
  const failures = []

  await checkNpmPackages(baseRef, exemptions.npm, failures)
  await checkCargoCrates(baseRef, exemptions.cargo, failures)

  if (failures.length === 0) {
    console.log(
      `Dependency age gate passed. Every new package version is at least ${minAgeDays} day(s) old or listed in ${EXEMPTIONS_FILE}.`,
    )
    return
  }

  console.error(`Dependency age gate failed. ${failures.length} package version(s) are too new or unverifiable.`)

  for (const failure of failures) {
    console.error(`- ${failure}`)
    console.error(`::error title=Dependency age gate failed::${escapeAnnotationValue(failure)}`)
  }

  process.exitCode = 1
}

const checkNpmPackages = async (baseRef, exempted, failures) => {
  const currentPackages = parsePnpmLock(readFileSync(LOCKFILE, 'utf8'))
  const basePackages = parsePnpmLock(readBaseFile(baseRef, LOCKFILE))
  const addedPackages = [...currentPackages.values()]
    .filter(pkg => !basePackages.has(createPackageKey(pkg)))
    .sort(comparePackages)

  if (addedPackages.length === 0) {
    console.log('No new pnpm package versions were added.')
    return
  }

  console.log(`Checking ${addedPackages.length} newly added pnpm package version(s).`)

  const metadataByName = new Map()

  for (const pkg of addedPackages) {
    const packageKey = createPackageKey(pkg)

    if (AGE_EXEMPT_PACKAGES.has(pkg.name)) {
      console.log(`Skipping ${packageKey}: first-party package exempt from the age gate.`)
      continue
    }

    if (ALLOWED_URL_DEPENDENCIES.has(pkg.name) && isUrlSourcedVersion(pkg.version)) {
      console.log(`Skipping ${packageKey}: pinned URL dependency, verified by the supply-chain gate.`)
      continue
    }

    if (isExempted(exempted, packageKey)) {
      continue
    }

    let metadata

    try {
      metadata = await fetchMetadata(pkg.name, metadataByName)
    } catch (error) {
      failures.push(`${packageKey}: npm metadata lookup failed: ${formatError(error)}`)
      continue
    }

    checkPublishedAt(packageKey, metadata.time?.[pkg.version], 'the npm registry', failures)
  }
}

const checkCargoCrates = async (baseRef, exempted, failures) => {
  const addedCrates = addedCargoCrates(baseRef, readBaseFile).sort(comparePackages)

  if (addedCrates.length === 0) {
    console.log('No new Cargo crate versions were added.')
    return
  }

  console.log(`Checking ${addedCrates.length} newly added Cargo crate version(s).`)

  const indexEntriesByName = new Map()

  for (const crate of addedCrates) {
    const crateKey = createPackageKey(crate)

    if (isExempted(exempted, crateKey)) {
      continue
    }

    if (!isCratesIoSource(crate.source)) {
      failures.push(`${crateKey}: comes from ${crate.source}, which has no crates.io publish date to gate on`)
      continue
    }

    let entries

    try {
      entries = await crateIndexEntries(crate.name, indexEntriesByName, fetchBody)
    } catch (error) {
      failures.push(`${crateKey}: crates.io index lookup failed: ${formatError(error)}`)
      continue
    }

    const entry = entries.find(candidate => candidate.vers === crate.version)
    checkPublishedAt(crateKey, entry?.pubtime, 'the crates.io index', failures)
  }
}

const checkPublishedAt = (packageKey, publishedAt, registry, failures) => {
  if (typeof publishedAt !== 'string') {
    failures.push(`${packageKey}: publish timestamp was not available from ${registry}`)
    return
  }

  const publishedTime = Date.parse(publishedAt)

  if (Number.isNaN(publishedTime)) {
    failures.push(`${packageKey}: publish timestamp is invalid: ${publishedAt}`)
    return
  }

  if (publishedTime > minimumPublishedAt) {
    const ageDays = Math.max(0, (Date.now() - publishedTime) / DAY_MS).toFixed(2)
    failures.push(`${packageKey}: published ${ageDays} day(s) ago, below the ${minAgeDays} day minimum`)
  }
}

const readExemptions = () => {
  if (!existsSync(EXEMPTIONS_FILE)) {
    return { npm: new Map(), cargo: new Map() }
  }

  const parsed = JSON.parse(readFileSync(EXEMPTIONS_FILE, 'utf8'))

  return { npm: exemptionsFor(parsed, 'npm'), cargo: exemptionsFor(parsed, 'cargo') }
}

const exemptionsFor = (parsed, ecosystem) => {
  const entries = parsed?.[ecosystem]

  if (!Array.isArray(entries)) {
    throw new Error(`${EXEMPTIONS_FILE} must hold a "${ecosystem}" array.`)
  }

  const exempted = new Map()

  for (const [position, entry] of entries.entries()) {
    const complete =
      typeof entry?.name === 'string' &&
      entry.name.length > 0 &&
      typeof entry.version === 'string' &&
      /^\d\S*$/.test(entry.version) &&
      typeof entry.reason === 'string' &&
      entry.reason.trim().length > 0

    if (!complete) {
      throw new Error(
        `${EXEMPTIONS_FILE}: ${ecosystem} entry ${position} must hold a name, an exact version, and a reason.`,
      )
    }

    exempted.set(createPackageKey(entry), entry.reason.trim())
  }

  return exempted
}

const isExempted = (exempted, packageKey) => {
  const reason = exempted.get(packageKey)

  if (reason === undefined) {
    return false
  }

  console.log(`Skipping ${packageKey}: ${EXEMPTIONS_FILE} lists it as verified: ${reason}`)
  return true
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(value, 10)

  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== value.trim()) {
    throw new Error('MIN_AGE_DAYS must be a positive integer.')
  }

  return parsed
}

const resolveBaseRef = () => {
  const candidates = [
    process.env.BASE_SHA,
    readBaseShaFromEvent(),
    process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : undefined,
    'origin/main',
    'HEAD~1',
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (gitCommitExists(candidate)) {
      return candidate
    }
  }

  throw new Error('Could not resolve a base commit to compare the lockfiles against.')
}

const readBaseShaFromEvent = () => {
  const eventPath = process.env.GITHUB_EVENT_PATH

  if (!eventPath || !existsSync(eventPath)) {
    return undefined
  }

  const event = JSON.parse(readFileSync(eventPath, 'utf8'))

  return event.pull_request?.base?.sha
}

const gitCommitExists = ref => {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}^{commit}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const readBaseFile = (baseRef, path) => {
  try {
    return execFileSync('git', ['show', `${baseRef}:${path}`], {
      encoding: 'utf8',
      maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return ''
  }
}

const parsePnpmLock = content => {
  const packages = new Map()
  let inPackages = false

  for (const line of content.split(/\r?\n/)) {
    if (line === 'packages:') {
      inPackages = true
      continue
    }

    if (inPackages && /^[a-zA-Z][^:]*:\s*$/.test(line)) {
      break
    }

    if (!inPackages) {
      continue
    }

    // biome-ignore lint/complexity/noAdjacentSpacesInRegex: this is intentional
    const match = line.match(/^  (['"]?)([^'"]+)\1:\s*$/)

    if (!match) {
      continue
    }

    const pkg = parsePnpmPackageKey(match[2])

    if (pkg) {
      packages.set(createPackageKey(pkg), pkg)
    }
  }

  return packages
}

const parsePnpmPackageKey = key => {
  const packageKey = key.split('(')[0]
  const versionSeparator = packageKey.lastIndexOf('@')

  if (versionSeparator <= 0) {
    return undefined
  }

  const name = packageKey.slice(0, versionSeparator)
  const version = packageKey.slice(versionSeparator + 1)

  if (!name || !version || version.startsWith('link:') || version.startsWith('workspace:')) {
    return undefined
  }

  return { name, version }
}

const fetchBody = async (url, accept, registry) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      headers: { Accept: accept, 'User-Agent': USER_AGENT },
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`${registry} returned HTTP ${response.status} for ${url}`)
    }

    return await response.text()
  } finally {
    clearTimeout(timeout)
  }
}

const fetchMetadata = async (name, cache) => {
  if (cache.has(name)) {
    return cache.get(name)
  }

  const metadata = JSON.parse(
    await fetchBody(`${REGISTRY_URL}/${encodeURIComponent(name)}`, 'application/json', 'npm registry'),
  )
  cache.set(name, metadata)

  return metadata
}

const formatError = error => (error instanceof Error ? error.message : String(error))

const createPackageKey = pkg => `${pkg.name}@${pkg.version}`

const comparePackages = (left, right) => createPackageKey(left).localeCompare(createPackageKey(right))

const escapeAnnotationValue = value => value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})

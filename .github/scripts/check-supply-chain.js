const { readFileSync, readdirSync, statSync } = require('node:fs')
const { join } = require('node:path')

const WORKFLOW_DIR = '.github/workflows'
const MINIMUM_RELEASE_AGE_DAYS = 4
const MINIMUM_RELEASE_AGE_MINUTES = MINIMUM_RELEASE_AGE_DAYS * 24 * 60
const PACKAGE_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies']
const TANSTACK_MALWARE_IOCS = [
  '@tanstack/setup',
  'github:tanstack/router#79ac49eedf774dd4b0cfa308722bc463cfe5885c',
  'router_init.js',
  'tanstack_runner.js',
  '79ac49eedf774dd4b0cfa308722bc463cfe5885c',
]

const main = () => {
  const failures = [
    ...checkWorkflows(),
    ...checkPackageManifests(),
    ...checkDependencyCooldowns(),
    ...checkLockfileIocs(),
  ]

  if (failures.length === 0) {
    console.log('Supply-chain gate passed.')
    return
  }

  console.error(`Supply-chain gate failed with ${failures.length} issue(s).`)

  for (const failure of failures) {
    console.error(`- ${failure}`)
    console.error(`::error title=Supply-chain gate failed::${escapeAnnotationValue(failure)}`)
  }

  process.exitCode = 1
}

const checkWorkflows = () => {
  const failures = []

  for (const file of listFiles(WORKFLOW_DIR, /\.(ya?ml)$/)) {
    const content = readFileSync(file, 'utf8')

    if (/^\s*pull_request_target:\s*$/m.test(content)) {
      failures.push(`${file}: pull_request_target is not allowed for this repository`)
    }

    for (const match of content.matchAll(/^\s*uses:\s*([^\s#]+).*$/gm)) {
      const action = match[1]

      if (action.startsWith('./')) {
        continue
      }

      const ref = action.includes('@') ? action.slice(action.lastIndexOf('@') + 1) : ''

      if (!/^[a-f0-9]{40}$/i.test(ref)) {
        failures.push(`${file}: action '${action}' must be pinned to a full commit SHA`)
      }
    }

    if (file !== '.github/workflows/publish.yml' && /^\s*id-token:\s*write\s*$/m.test(content)) {
      failures.push(`${file}: id-token: write is only allowed in publish.yml`)
    }
  }

  return failures
}

const checkPackageManifests = () => {
  const failures = []

  for (const file of listFiles('.', /(^|\/)package\.json$/)) {
    if (file.includes('/node_modules/')) {
      continue
    }

    const manifest = JSON.parse(readFileSync(file, 'utf8'))

    for (const section of PACKAGE_SECTIONS) {
      for (const [name, specifier] of Object.entries(manifest[section] || {})) {
        if (specifier === 'latest') {
          failures.push(`${file}: ${section}.${name} must not use latest`)
        }

        if (/^(github:|git\+|https?:\/\/)/.test(specifier)) {
          failures.push(`${file}: ${section}.${name} must not use a remote git or URL dependency`)
        }
      }
    }
  }

  return failures
}

const checkDependencyCooldowns = () => {
  const failures = []
  const workspace = readFileSync('pnpm-workspace.yaml', 'utf8')
  const workspaceMatch = workspace.match(/^minimumReleaseAge:\s*(\d+)\s*$/m)
  const workspaceMinutes = workspaceMatch ? Number.parseInt(workspaceMatch[1], 10) : undefined

  if (!Number.isSafeInteger(workspaceMinutes) || workspaceMinutes < MINIMUM_RELEASE_AGE_MINUTES) {
    failures.push(`pnpm-workspace.yaml: minimumReleaseAge must be at least ${MINIMUM_RELEASE_AGE_MINUTES} minutes`)
  }

  const dependabot = readFileSync('.github/dependabot.yml', 'utf8')
  const cooldowns = [...dependabot.matchAll(/^\s*cooldown:\s*\n\s+default-days:\s*(\d+)\s*$/gm)]
    .map((match) => Number.parseInt(match[1], 10))

  if (cooldowns.length < 2 || cooldowns.some((days) => !Number.isSafeInteger(days) || days < MINIMUM_RELEASE_AGE_DAYS)) {
    failures.push(`.github/dependabot.yml: npm and GitHub Actions updates must use cooldown.default-days >= ${MINIMUM_RELEASE_AGE_DAYS}`)
  }

  return failures
}

const checkLockfileIocs = () => {
  const content = readFileSync('pnpm-lock.yaml', 'utf8')
  const failures = []

  for (const indicator of TANSTACK_MALWARE_IOCS) {
    if (content.includes(indicator)) {
      failures.push(`pnpm-lock.yaml contains known TanStack malware indicator '${indicator}'`)
    }
  }

  return failures
}

const listFiles = (directory, pattern) => {
  const files = []

  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)

    if (entry === 'node_modules' || entry === '.git') {
      continue
    }

    const stats = statSync(path)

    if (stats.isDirectory()) {
      files.push(...listFiles(path, pattern))
      continue
    }

    if (pattern.test(path)) {
      files.push(path)
    }
  }

  return files.sort()
}

const escapeAnnotationValue = (value) =>
  value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')

main()

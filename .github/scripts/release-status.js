const { execFileSync } = require('node:child_process')
const { appendFileSync } = require('node:fs')

const STABLE_RELEASE = /^(\d+)\.(\d+)\.(\d+)$/
const NATIVE_CORE_SOURCES = ['packages/native/src', 'packages/native/include']
const CHANGELOGS = ':(exclude,glob)**/CHANGELOG.md'
const LISTED_COMMITS_PER_PACKAGE = 20

const PUBLISHED_PACKAGES = [
  {
    name: '@delali/narsil',
    tagPrefix: 'narsil-ts@v',
    paths: ['packages/ts', 'packages/native/npm', ...NATIVE_CORE_SOURCES],
  },
  {
    name: '@delali/narsil-react-native',
    tagPrefix: 'narsil-ts@v',
    paths: ['packages/react-native', ...NATIVE_CORE_SOURCES],
  },
  {
    name: '@delali/narsil-embeddings-transformers',
    tagPrefix: 'narsil-embeddings-transformers@v',
    paths: ['packages/embeddings-transformers'],
  },
  { name: '@delali/narsil-certutil', tagPrefix: 'narsil-certutil@v', paths: ['packages/certutil'] },
  { name: 'narsil-client', tagPrefix: 'narsil-python@v', paths: ['packages/python'] },
  { name: 'delali-narsil on crates.io', tagPrefix: 'narsil-rust@v', paths: ['packages/rust', ...NATIVE_CORE_SOURCES] },
  {
    name: 'delali-narsil on PyPI',
    tagPrefix: 'narsil-python-engine@v',
    paths: ['packages/python-engine', 'packages/rust/src', 'packages/rust/Cargo.toml', ...NATIVE_CORE_SOURCES],
  },
  {
    name: 'github.com/assetcorp/narsil/packages/go',
    tagPrefix: 'packages/go/v',
    paths: ['packages/go', ':(exclude)packages/go/engine', ':(exclude)packages/go/changes'],
  },
  {
    name: 'github.com/assetcorp/narsil/packages/go/engine',
    tagPrefix: 'packages/go/engine/v',
    paths: ['packages/go/engine'],
  },
  {
    name: 'github.com/assetcorp/narsil/packages/go/changes',
    tagPrefix: 'packages/go/changes/v',
    paths: ['packages/go/changes'],
  },
]

const git = args => execFileSync('git', args, { encoding: 'utf8' })

function comparedReleases(left, right) {
  const differing = left.findIndex((part, index) => part !== right[index])
  return differing === -1 ? 0 : left[differing] - right[differing]
}

function newestStableTag(tagPrefix) {
  let newest = null
  for (const tag of git(['tag', '--list', `${tagPrefix}*`]).split('\n')) {
    const match = STABLE_RELEASE.exec(tag.slice(tagPrefix.length))
    if (match === null) continue
    const parts = match.slice(1).map(Number)
    if (newest === null || comparedReleases(parts, newest.parts) > 0) newest = { tag, parts }
  }
  return newest?.tag ?? null
}

function statusOf(published) {
  const tag = newestStableTag(published.tagPrefix)
  if (tag === null) {
    throw new Error(
      `No ${published.tagPrefix}X.Y.Z tag is in this clone, so fetch every tag before you list the release status of ${published.name}`,
    )
  }
  const range = `${tag}..HEAD`
  const pathspec = ['--', ...published.paths, CHANGELOGS]
  const count = Number(git(['rev-list', '--count', range, ...pathspec]).trim())
  const commits = git(['log', `--max-count=${LISTED_COMMITS_PER_PACKAGE}`, '--format=%h %s', range, ...pathspec])
    .split('\n')
    .filter(line => line.length > 0)
  return { ...published, tag, count, commits }
}

function markdown(statuses) {
  const unreleased = statuses.filter(status => status.count > 0)
  const lines = ['## Packages with commits since their last release', '']
  if (unreleased.length === 0) {
    lines.push('Every published package matches its last release tag.')
    return `${lines.join('\n')}\n`
  }
  lines.push('| Package | Last release tag | Commits since |', '|---|---|---|')
  for (const status of unreleased) lines.push(`| \`${status.name}\` | \`${status.tag}\` | ${status.count} |`)
  for (const status of unreleased) {
    lines.push('', `### \`${status.name}\` since \`${status.tag}\``, '')
    for (const commit of status.commits) lines.push(`- ${commit.replaceAll('|', '\\|')}`)
    if (status.count > status.commits.length)
      lines.push(`- and ${status.count - status.commits.length} earlier commits`)
  }
  return `${lines.join('\n')}\n`
}

function main() {
  if (git(['rev-parse', '--is-shallow-repository']).trim() !== 'false') {
    throw new Error('This clone is shallow, so check it out with fetch-depth 0 before you list the release status')
  }
  const report = markdown(PUBLISHED_PACKAGES.map(statusOf))
  process.stdout.write(report)
  const summary = process.env.GITHUB_STEP_SUMMARY
  if (summary !== undefined && summary !== '') appendFileSync(summary, report)
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

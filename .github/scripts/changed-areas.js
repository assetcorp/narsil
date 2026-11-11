const { execFileSync } = require('node:child_process')
const { appendFileSync } = require('node:fs')

const AREAS_SCRIPT = '.github/scripts/changed-areas.js'
const MISSING_COMMIT = /^0+$/
const BENCHMARK_HARNESS_PREFIX = 'benchmarks/server/'
const PATHS_OUTSIDE_TYPESCRIPT = [
  'docs/',
  'assets/',
  'skills/',
  'benchmarks/',
  'packages/rust/',
  'packages/go/engine/',
  'packages/react-native/',
  'packages/embeddings-transformers/',
  '.github/workflows/',
  '.github/scripts/',
  '.github/ISSUE_TEMPLATE/',
]

const git = args => execFileSync('git', args, { encoding: 'utf8' })

const namesBetween = (from, to) =>
  git(['diff', '--name-only', from, to])
    .split('\n')
    .filter(line => line.length > 0)

const changedFiles = () => {
  const event = process.env.GITHUB_EVENT_NAME
  if (event === 'pull_request') return namesBetween('HEAD^1', 'HEAD')
  if (event !== 'push') return null
  const before = process.env.PUSH_BEFORE ?? ''
  const after = process.env.GITHUB_SHA ?? ''
  if (before === '' || after === '' || MISSING_COMMIT.test(before)) return null
  git(['fetch', '--no-tags', '--depth=1', 'origin', before])
  return namesBetween(before, after)
}

const isMarkdown = path => path.endsWith('.md')

const writeOutput = (key, value) => {
  console.log(`${key}=${value}`)
  const target = process.env.GITHUB_OUTPUT
  if (target !== undefined) appendFileSync(target, `${key}=${value}\n`)
}

const main = () => {
  let files = null
  try {
    files = changedFiles()
  } catch (error) {
    console.log(`Reading the changed files failed, so every area counts as changed: ${error.message}`)
  }

  if (files === null) {
    console.log('This event lists no changed files, so every area counts as changed.')
    writeOutput('typescript', 'true')
    writeOutput('benchmark_harness', 'true')
    return
  }

  console.log(`Changed files:\n${files.join('\n')}`)
  const workflow = process.env.WORKFLOW_FILE ?? ''
  const definitionChanged = files.some(path => path === workflow || path === AREAS_SCRIPT)
  const typescript = files.some(
    path => !isMarkdown(path) && !PATHS_OUTSIDE_TYPESCRIPT.some(prefix => path.startsWith(prefix)),
  )
  const benchmarkHarness = files.some(path => !isMarkdown(path) && path.startsWith(BENCHMARK_HARNESS_PREFIX))

  writeOutput('typescript', String(definitionChanged || typescript))
  writeOutput('benchmark_harness', String(definitionChanged || benchmarkHarness))
}

main()

const { execFileSync } = require('node:child_process')
const { appendFileSync } = require('node:fs')

const AREAS_SCRIPT = '.github/scripts/changed-areas.js'
const MISSING_COMMIT = /^0+$/
const AREAS = ['typescript', 'check', 'conformance', 'benchmark_harness']
const TYPESCRIPT_AREAS = ['typescript', 'check', 'conformance']

const AREAS_BY_PREFIX = [
  ['docs/', []],
  ['assets/', []],
  ['skills/', []],
  ['benchmarks/server/', ['benchmark_harness']],
  ['benchmarks/', []],
  ['packages/rust/', []],
  ['packages/python-engine/', []],
  ['packages/go/engine/', []],
  ['packages/go/changes/', []],
  ['packages/react-native/', []],
  ['packages/embeddings-transformers/', []],
  ['packages/native/fuzz/', []],
  ['packages/native/test/', []],
  ['packages/conformance/samples/earlier-releases/', ['typescript', 'conformance']],
  ['packages/conformance/', ['conformance']],
  ['packages/certutil/', ['check']],
  ['packages/python/', ['check']],
  ['packages/go/', ['check']],
  ['.github/workflows/', []],
  ['.github/scripts/', []],
  ['.github/ISSUE_TEMPLATE/', []],
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

const areasOf = path => {
  if (path.endsWith('.md')) return []
  const rule = AREAS_BY_PREFIX.find(([prefix]) => path.startsWith(prefix))
  return rule === undefined ? TYPESCRIPT_AREAS : rule[1]
}

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

  const workflow = process.env.WORKFLOW_FILE ?? ''
  const touched = new Set()
  if (files === null) {
    console.log('This event lists no changed files, so every area counts as changed.')
    for (const area of AREAS) touched.add(area)
  } else {
    console.log(`Changed files:\n${files.join('\n')}`)
    for (const path of files) {
      const areas = path === workflow || path === AREAS_SCRIPT ? AREAS : areasOf(path)
      for (const area of areas) touched.add(area)
    }
  }

  for (const area of AREAS) writeOutput(area, String(touched.has(area)))
}

main()

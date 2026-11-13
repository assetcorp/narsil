const { execFileSync } = require('node:child_process')
const { appendFileSync } = require('node:fs')

const AREAS_SCRIPT = '.github/scripts/changed-areas.js'
const SHARED_ENGINE_WORKFLOW = '.github/workflows/engine.yml'
const MISSING_COMMIT = /^0+$/
const TYPESCRIPT_JOB_AREAS = ['typescript', 'check', 'conformance', 'benchmark_harness', 'benchmark_languages']
const TYPESCRIPT_AREAS = ['typescript', 'check', 'conformance']

const AREAS_BY_PREFIX = [
  ['docs/', []],
  ['assets/', []],
  ['skills/', []],
  ['benchmarks/server/', ['benchmark_harness']],
  ['benchmarks/engine-languages/', ['benchmark_languages']],
  ['benchmarks/in-process/src/data/', ['benchmark_languages']],
  ['benchmarks/in-process/src/runner/', ['benchmark_languages']],
  ['benchmarks/in-process/src/perf-corpus.ts', ['benchmark_languages']],
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
  ['packages/conformance/oracle/', ['conformance', 'benchmark_languages']],
  ['packages/conformance/', ['conformance']],
  ['packages/certutil/', ['check']],
  ['packages/python/', ['check']],
  ['packages/go/', ['check']],
  ['.github/workflows/', []],
  ['.github/scripts/', []],
  ['.github/ISSUE_TEMPLATE/', []],
]

const FOLDERS_OUTSIDE_THE_ENGINE_BUNDLE = [
  'packages/ts/src/__tests__/',
  'packages/ts/src/client/',
  'packages/ts/src/react/',
  'packages/ts/src/http-retry/',
  'packages/ts/src/rerankers/',
  'packages/ts/src/embeddings/',
  'packages/ts/src/invalidation/',
]

const PATHS_BY_LANGUAGE_AREA = {
  rust: {
    paths: [
      'packages/rust/',
      'packages/native/src/',
      'packages/native/include/',
      'packages/conformance/',
      'packages/ts/src/',
      '.github/workflows/rust.yml',
    ],
    except: FOLDERS_OUTSIDE_THE_ENGINE_BUNDLE,
    compiledMarkdown: ['packages/rust/README.md'],
  },
  python_engine: {
    paths: [
      'packages/python-engine/',
      'packages/rust/',
      'packages/native/src/',
      'packages/native/include/',
      'packages/conformance/',
      'packages/ts/src/',
      '.github/workflows/python-engine.yml',
    ],
    except: ['packages/rust/tests/', ...FOLDERS_OUTSIDE_THE_ENGINE_BUNDLE],
  },
  go_engine: {
    paths: [
      'packages/go/engine/',
      'packages/native/include/',
      'packages/native/src/',
      'packages/conformance/',
      'packages/spec/',
      'packages/ts/src/',
      '.github/workflows/go-engine.yml',
    ],
    except: FOLDERS_OUTSIDE_THE_ENGINE_BUNDLE,
  },
  native_core: {
    paths: [
      'packages/native/',
      'packages/ts/src/vector/',
      'packages/ts/src/languages/',
      'packages/ts/src/core/tokenizer/',
      'packages/ts/src/core/keyword-score/',
      'packages/ts/src/core/partition/',
      'packages/ts/src/core/inverted-index/',
      'packages/ts/src/core/synonyms/',
      'packages/ts/src/core/ordering/',
      'packages/ts/src/core/scorer.ts',
      'packages/ts/src/math/',
      'packages/ts/src/geo/',
      'packages/ts/src/__tests__/core/tokenizer/',
      'packages/ts/src/__tests__/core/keyword-score/',
      'packages/ts/src/__tests__/math/',
      'packages/ts/scripts/native-analysis/',
      'packages/ts/wasm/',
      '.github/workflows/native-core.yml',
    ],
  },
  clients: {
    paths: [
      'packages/python/',
      'packages/go/',
      'packages/ts/openapi.json',
      'packages/ts/src/server/',
      'packages/ts/src/changes/',
      'packages/ts/scripts/client-test-server.mjs',
      '.github/workflows/clients.yml',
    ],
    except: ['packages/go/engine/'],
  },
  react_native: {
    paths: [
      'packages/react-native/',
      'packages/native/src/',
      'packages/native/include/',
      'packages/ts/src/',
      'packages/ts/package.json',
      'packages/ts/tsup.config.ts',
      'pnpm-lock.yaml',
      '.github/workflows/react-native.yml',
    ],
    except: ['packages/ts/src/__tests__/', 'packages/ts/src/react/'],
  },
  cluster: {
    paths: [
      'packages/ts/src/distribution/',
      'packages/ts/src/__tests__/e2e/cluster-faults/',
      'packages/ts/src/__tests__/e2e/cluster-memory/',
    ],
  },
  vector_recall: {
    paths: ['packages/ts/src/vector/', 'packages/ts/src/__tests__/vector/recall.test.ts'],
  },
}

const LANGUAGE_AREAS = Object.keys(PATHS_BY_LANGUAGE_AREA)
const AREAS = [...TYPESCRIPT_JOB_AREAS, ...LANGUAGE_AREAS]
const CI_AREAS_THAT_LOAD_THE_ENGINE = [
  'typescript',
  'conformance',
  'rust',
  'python_engine',
  'go_engine',
  'native_core',
  'clients',
  'cluster',
  'vector_recall',
]

const git = args => execFileSync('git', args, { encoding: 'utf8' })

const namesBetween = (from, to) =>
  git(['diff', '--name-only', '--no-renames', '-z', from, to])
    .split('\0')
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

const typescriptAreasOf = path => {
  if (path.endsWith('.md')) return []
  const rule = AREAS_BY_PREFIX.find(([prefix]) => path.startsWith(prefix))
  return rule === undefined ? TYPESCRIPT_AREAS : rule[1]
}

const matchesAnyPath = (path, entries) =>
  entries.some(entry => (entry.endsWith('/') ? path.startsWith(entry) : path === entry))

const touchesLanguageArea = (path, { paths, except = [], compiledMarkdown = [] }) => {
  if (path.endsWith('.md')) return compiledMarkdown.includes(path)
  return matchesAnyPath(path, paths) && !matchesAnyPath(path, except)
}

const areasOf = path => [
  ...typescriptAreasOf(path),
  ...LANGUAGE_AREAS.filter(area => touchesLanguageArea(path, PATHS_BY_LANGUAGE_AREA[area])),
]

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

  const filesThatTouchEveryArea = new Set([process.env.WORKFLOW_FILE ?? '', AREAS_SCRIPT, SHARED_ENGINE_WORKFLOW])
  const touched = new Set()
  if (files === null) {
    console.log('This event lists no changed files, so every area counts as changed.')
    for (const area of AREAS) touched.add(area)
  } else {
    const quotedFiles = files.map(path => JSON.stringify(path).replaceAll('##[', '##\\u005b'))
    console.log(`Changed files:\n${quotedFiles.join('\n')}`)
    for (const path of files) {
      const areas = filesThatTouchEveryArea.has(path) ? AREAS : areasOf(path)
      for (const area of areas) touched.add(area)
    }
  }

  for (const area of AREAS) writeOutput(area, String(touched.has(area)))
  writeOutput('engine', String(CI_AREAS_THAT_LOAD_THE_ENGINE.some(area => touched.has(area))))
}

main()

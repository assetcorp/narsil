const {
  COMPOSITE_ACTIONS,
  ENGINE_API_REPORTS,
  ENGINE_BUILD_FILES,
  FOLDERS_OUTSIDE_THE_ENGINE_BUNDLE,
  MARKDOWN_THAT_THE_CHECK_JOB_COMPILES,
  PATHS_BY_LANGUAGE_AREA,
  README_EXAMPLE_SCRIPTS,
  WORKSPACE_FILES,
} = require('./changed-areas.js')

const CI_WORKFLOW = '.github/workflows/ci.yml'
const PUBLISH_WORKFLOW = '.github/workflows/publish.yml'
const ENGINE_WORKFLOW = '.github/workflows/engine.yml'
const EMBEDDINGS_WORKFLOW = '.github/workflows/embeddings.yml'
const CHECK_JOB_GO_VERSION = 'packages/go/go.mod'

const ENGINE_MANIFEST = 'packages/ts/package.json'
const TYPESCRIPT_PACKAGES = ['packages/ts/', 'packages/embeddings-transformers/']
const TYPESCRIPT_IMPORTERS = ['.', 'packages/ts', 'packages/embeddings-transformers']
const ENGINE_TESTS = 'packages/ts/src/__tests__/'
const EMBEDDING_INTEGRATION_TESTS = [
  'embedding-e2e.test.ts',
  'embedding-e2e-batch-parity.test.ts',
  'embedding-e2e-reranker.test.ts',
].map(name => `${ENGINE_TESTS}integration/${name}`)
const NATIVE_CORE = 'Native search core'
const NATIVE_CORE_LINT_PARTS = 2

const parts = (count, name) => Array.from({ length: count }, (_, index) => name(index + 1, count))

const areaPaths = area => PATHS_BY_LANGUAGE_AREA[area].paths

const compiledMarkdown = area => PATHS_BY_LANGUAGE_AREA[area].compiledMarkdown ?? []

const workflowFiles = (...files) => [...files, COMPOSITE_ACTIONS]

const CLIENT_TEST_SERVER_INPUTS = [
  'packages/ts/src/',
  'packages/ts/openapi.json',
  'packages/ts/scripts/client-test-server.mjs',
  ...ENGINE_BUILD_FILES,
  ...README_EXAMPLE_SCRIPTS,
  ...WORKSPACE_FILES,
  ...workflowFiles('.github/workflows/clients.yml', CI_WORKFLOW, ENGINE_WORKFLOW),
]

const SUITES = {
  'typescript-suite': {
    workflows: ['publish.yml'],
    jobs: [
      ...parts(4, (part, count) => `TypeScript tests, part ${part} of ${count}`),
      ...parts(2, (part, count) => `TypeScript suites on etcd and under a memory limit, part ${part} of ${count}`),
    ],
    paths: [
      ...TYPESCRIPT_PACKAGES,
      'packages/conformance/samples/earlier-releases/',
      'packages/native/npm/',
      ...WORKSPACE_FILES,
      ...workflowFiles(PUBLISH_WORKFLOW, ENGINE_WORKFLOW),
    ],
    except: [ENGINE_API_REPORTS],
    importers: TYPESCRIPT_IMPORTERS,
  },
  'typescript-checks': {
    workflows: ['ci.yml'],
    jobs: ['Check'],
    paths: [
      ...TYPESCRIPT_PACKAGES,
      CHECK_JOB_GO_VERSION,
      '.github/scripts/check-guide-examples.js',
      ...README_EXAMPLE_SCRIPTS,
      ...WORKSPACE_FILES,
      ...workflowFiles(CI_WORKFLOW),
    ],
    markdown: [...MARKDOWN_THAT_THE_CHECK_JOB_COMPILES, ENGINE_API_REPORTS],
    importers: TYPESCRIPT_IMPORTERS,
  },
  certutil: {
    workflows: ['ci.yml'],
    jobs: ['Check'],
    paths: [
      'packages/certutil/',
      CHECK_JOB_GO_VERSION,
      ...README_EXAMPLE_SCRIPTS,
      ...WORKSPACE_FILES,
      ...workflowFiles(CI_WORKFLOW),
    ],
    markdown: MARKDOWN_THAT_THE_CHECK_JOB_COMPILES,
    importers: ['.', 'packages/certutil'],
  },
  'embedding-adapters': {
    workflows: ['embeddings.yml'],
    jobs: ['Embedding Adapter Tests'],
    paths: ['packages/embeddings-transformers/', ...WORKSPACE_FILES, ...workflowFiles(EMBEDDINGS_WORKFLOW)],
    importers: ['.', 'packages/embeddings-transformers'],
  },
  'embedding-integration': {
    workflows: ['embeddings.yml'],
    jobs: ['Embedding Integration Tests'],
    paths: [
      'packages/ts/src/',
      'packages/ts/scripts/',
      ENGINE_API_REPORTS,
      ...ENGINE_BUILD_FILES,
      'packages/ts/tsconfig.test.json',
      'packages/ts/vitest.config.ts',
      'packages/embeddings-transformers/',
      ...WORKSPACE_FILES,
      ...workflowFiles(EMBEDDINGS_WORKFLOW),
    ],
    except: [ENGINE_TESTS],
    keptInsideExcept: [...EMBEDDING_INTEGRATION_TESTS, `${ENGINE_TESTS}rerank/oracle.ts`, `${ENGINE_TESTS}setup/`],
    markdown: [ENGINE_API_REPORTS],
    importers: TYPESCRIPT_IMPORTERS,
  },
  'native-core': {
    workflows: ['publish.yml', 'ci.yml'],
    jobs: [
      ...['linux-x64', 'linux-x64-musl', 'linux-arm64', 'linux-arm64-musl', 'win32-x64', 'win32-arm64'].map(
        target => `${NATIVE_CORE} / Build ${target}`,
      ),
      ...['x86-64', '64-bit Arm'].map(label => `${NATIVE_CORE} / Test the core in C under the sanitisers on ${label}`),
      `${NATIVE_CORE} / Test the Node binding under the sanitisers`,
      `${NATIVE_CORE} / Fuzz every entry point that decodes caller or file bytes`,
      ...['linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64', 'linux-x64-musl', 'linux-arm64-musl'].map(
        label => `${NATIVE_CORE} / Compare the core with the WebAssembly search on ${label}`,
      ),
    ],
    paths: [
      'packages/native/',
      'packages/ts/',
      ...WORKSPACE_FILES,
      ...workflowFiles('.github/workflows/native-core.yml', PUBLISH_WORKFLOW, CI_WORKFLOW, ENGINE_WORKFLOW),
    ],
    except: [ENGINE_API_REPORTS],
    importers: ['.', 'packages/ts', 'packages/native'],
  },
  'native-core-lint': {
    workflows: ['ci.yml'],
    jobs: parts(
      NATIVE_CORE_LINT_PARTS,
      (part, count) => `${NATIVE_CORE} / Check the C code with clang-tidy and clang-format, part ${part} of ${count}`,
    ),
    paths: [
      ...areaPaths('native_core'),
      ...ENGINE_BUILD_FILES,
      ...WORKSPACE_FILES,
      ...workflowFiles(CI_WORKFLOW, ENGINE_WORKFLOW),
    ],
    markdown: compiledMarkdown('native_core'),
    manifestsWithoutVersion: [ENGINE_MANIFEST],
    importers: ['.', 'packages/ts', 'packages/native'],
  },
  'react-native-android': {
    workflows: ['publish.yml'],
    jobs: ['expo', 'bare'].map(app => `Build the React Native apps / Android (${app})`),
    paths: [
      ...areaPaths('react_native'),
      ...ENGINE_BUILD_FILES,
      ...WORKSPACE_FILES,
      ...workflowFiles(PUBLISH_WORKFLOW, ENGINE_WORKFLOW),
    ],
    except: PATHS_BY_LANGUAGE_AREA.react_native.except,
    markdown: compiledMarkdown('react_native'),
    importers: [
      '.',
      'packages/ts',
      'packages/react-native',
      'packages/react-native/examples/expo',
      'packages/react-native/examples/bare',
    ],
  },
  rust: {
    workflows: ['ci.yml'],
    jobs: [
      'Rust crate / Format and Clippy',
      'Rust crate / Test on linux-x64, part 1 of 1',
      ...parts(2, (part, count) => `Rust crate / Test on darwin-arm64, part ${part} of ${count}`),
      ...parts(5, (part, count) => `Rust crate / Test on win32-x64, part ${part} of ${count}`),
    ],
    paths: [
      ...areaPaths('rust'),
      ...ENGINE_BUILD_FILES,
      ...WORKSPACE_FILES,
      ...workflowFiles(CI_WORKFLOW, ENGINE_WORKFLOW),
    ],
    except: FOLDERS_OUTSIDE_THE_ENGINE_BUNDLE,
    markdown: compiledMarkdown('rust'),
    manifestsWithoutVersion: [ENGINE_MANIFEST],
    importers: ['.', 'packages/ts', 'packages/conformance'],
  },
  'go-engine': {
    workflows: ['ci.yml'],
    jobs: [
      'Go engine / Core copy, gofmt, and go vet',
      ...['1.26', 'stable'].flatMap(go =>
        parts(2, (part, count) => `Go engine / Test on linux-x64 with Go ${go}, part ${part} of ${count}`),
      ),
      ...parts(2, (part, count) => `Go engine / Test on darwin-arm64 with Go stable, part ${part} of ${count}`),
      ...parts(5, (part, count) => `Go engine / Test on win32-x64 with Go stable, part ${part} of ${count}`),
    ],
    paths: [
      ...areaPaths('go_engine'),
      ...ENGINE_BUILD_FILES,
      ...WORKSPACE_FILES,
      ...workflowFiles(CI_WORKFLOW, ENGINE_WORKFLOW),
    ],
    except: FOLDERS_OUTSIDE_THE_ENGINE_BUNDLE,
    markdown: compiledMarkdown('go_engine'),
    manifestsWithoutVersion: [ENGINE_MANIFEST],
    importers: ['.', 'packages/ts', 'packages/conformance'],
  },
  'python-engine': {
    workflows: ['ci.yml'],
    jobs: [
      'Python package / Lint, type-check, and save the reference index with the TypeScript engine',
      'Python package / Build the wheel for linux-x64-gnu',
      'Python package / Build the wheel for win32-x64',
      'Python package / Test the linux-x64-gnu wheel on Python 3.11',
      'Python package / Test the linux-x64-gnu wheel on Python 3.14',
      'Python package / Build and test the darwin-arm64 wheel on Python 3.14',
      'Python package / Test the win32-x64 wheel on Python 3.14',
    ],
    paths: [
      ...areaPaths('python_engine'),
      ...ENGINE_BUILD_FILES,
      ...WORKSPACE_FILES,
      ...workflowFiles(CI_WORKFLOW, ENGINE_WORKFLOW),
    ],
    except: PATHS_BY_LANGUAGE_AREA.python_engine.except,
    markdown: compiledMarkdown('python_engine'),
    manifestsWithoutVersion: [ENGINE_MANIFEST],
    importers: ['.', 'packages/ts', 'packages/conformance'],
  },
  'python-client': {
    workflows: ['ci.yml'],
    jobs: ['3.11', '3.14'].map(python => `Clients / Python client (${python})`),
    paths: ['packages/python/', ...CLIENT_TEST_SERVER_INPUTS],
    except: [ENGINE_TESTS],
    markdown: compiledMarkdown('clients'),
    importers: TYPESCRIPT_IMPORTERS,
  },
  'go-client': {
    workflows: ['ci.yml'],
    jobs: ['1.26', 'stable'].map(go => `Clients / Go client (${go})`),
    paths: ['packages/go/', ...CLIENT_TEST_SERVER_INPUTS],
    except: ['packages/go/engine/', ENGINE_TESTS],
    markdown: compiledMarkdown('clients'),
    importers: TYPESCRIPT_IMPORTERS,
  },
}

const NPM_ENGINE_SUITES = [
  'typescript-suite',
  'typescript-checks',
  'embedding-integration',
  'native-core',
  'native-core-lint',
  'react-native-android',
]

const SUITES_BY_PACKAGE = {
  '@delali/narsil': NPM_ENGINE_SUITES,
  '@delali/narsil-embeddings-transformers': ['embedding-adapters'],
  '@delali/narsil-certutil': ['certutil'],
  all: [...NPM_ENGINE_SUITES, 'embedding-adapters', 'certutil'],
  'narsil-client': ['python-client'],
  'github.com/assetcorp/narsil/packages/go': ['go-client'],
  'github.com/assetcorp/narsil/packages/go/changes': ['go-client'],
  'github.com/assetcorp/narsil/packages/go/engine': ['go-engine'],
  'delali-narsil': ['rust'],
  'delali-narsil on PyPI': ['python-engine'],
}

module.exports = { SUITES, SUITES_BY_PACKAGE }

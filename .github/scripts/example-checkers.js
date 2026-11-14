const { spawnSync } = require('node:child_process')
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { join, relative, sep } = require('node:path')
const { describe } = require('./readme-code-blocks.js')

const EXAMPLE_RUN_TIMEOUT_MS = 120_000
const EXAMPLE_COMPILE_TIMEOUT_MS = 600_000
const ON_WINDOWS = process.platform === 'win32'

function run(command, args, options) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    timeout: options.timeoutMs,
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
  })
  if (result.error !== undefined)
    throw new Error(`${options.label} could not start ${command}: ${result.error.message}`)
  if (result.signal !== null)
    throw new Error(`${options.label} stopped on ${result.signal} within ${options.timeoutMs} ms`)
  if (result.status !== 0) throw new Error(`${options.label} exited with status ${result.status}`)
}

function requireDistinctNames(blocks) {
  const seen = new Map()
  for (const block of blocks) {
    const earlier = seen.get(block.name)
    if (earlier !== undefined) {
      throw new Error(`${describe(earlier)} and ${describe(block)} both write the example file ${block.name}`)
    }
    seen.set(block.name, block)
  }
}

function compileLabel(tool, blocks, fileOf) {
  const lines = blocks.map(block => {
    const setup = block.setupLineCount > 0 ? `, after ${block.setupLineCount} hidden setup lines` : ''
    return `  ${fileOf(block)} holds ${describe(block)}${setup}`
  })
  return `${tool} of these code blocks:\n${lines.join('\n')}\n`
}

function goVersionOf(moduleRoot) {
  const match = /^go\s+(\S+)\s*$/m.exec(readFileSync(join(moduleRoot, 'go.mod'), 'utf8'))
  if (match === null) throw new Error(`${join(moduleRoot, 'go.mod')} holds no go directive`)
  return match[1]
}

function checkGo(blocks, moduleRoot, workspace, dependentModuleRoots = []) {
  requireDistinctNames(blocks)
  const goVersion = goVersionOf(moduleRoot)
  for (const block of blocks) {
    const directory = join(workspace, block.name)
    mkdirSync(directory)
    writeFileSync(join(directory, 'go.mod'), `module readme.example/${block.name}\n\ngo ${goVersion}\n`)
    writeFileSync(join(directory, 'main.go'), block.code)
  }
  const uses = [
    ...blocks.map(block => `./${block.name}`),
    ...[moduleRoot, ...dependentModuleRoots].map(root => root.replaceAll('\\', '/')),
  ]
  const useLines = uses.map(use => `\t${JSON.stringify(use)}\n`).join('')
  writeFileSync(join(workspace, 'go.work'), `go ${goVersion}\n\nuse (\n${useLines})\n`)
  const env = { GOWORK: join(workspace, 'go.work'), GOFLAGS: '', GOPROXY: 'off' }
  const packages = blocks.map(block => `./${block.name}`)
  const binaries = join(workspace, 'bin')
  mkdirSync(binaries)
  run('go', ['build', '-buildvcs=false', '-o', `${binaries}${sep}`, ...packages], {
    cwd: workspace,
    env,
    timeoutMs: EXAMPLE_COMPILE_TIMEOUT_MS,
    label: compileLabel('go build', blocks, block => `${block.name}/main.go`),
  })
  run('go', ['vet', ...packages], {
    cwd: workspace,
    env,
    timeoutMs: EXAMPLE_COMPILE_TIMEOUT_MS,
    label: compileLabel('go vet', blocks, block => `${block.name}/main.go`),
  })
  for (const block of blocks.filter(candidate => candidate.runs)) {
    run(join(binaries, ON_WINDOWS ? `${block.name}.exe` : block.name), [], {
      cwd: join(workspace, block.name),
      timeoutMs: EXAMPLE_RUN_TIMEOUT_MS,
      label: `the program of ${describe(block)}`,
    })
  }
}

function checkPython(blocks, packageRoot, workspace, { typeCheck = true, execute = true } = {}) {
  requireDistinctNames(blocks)
  const fileOf = block => join(workspace, `${block.name}.py`)
  for (const block of blocks) writeFileSync(fileOf(block), block.code)
  if (typeCheck) {
    run('python3', [join('scripts', 'tools.py'), 'mypy', ...blocks.map(fileOf)], {
      cwd: packageRoot,
      timeoutMs: EXAMPLE_COMPILE_TIMEOUT_MS,
      label: compileLabel('mypy', blocks, block => `${block.name}.py`),
    })
  }
  if (!execute) return
  const environmentPython = join(
    packageRoot,
    '.venv',
    ON_WINDOWS ? 'Scripts' : 'bin',
    ON_WINDOWS ? 'python.exe' : 'python',
  )
  const python = process.env.NARSIL_EXAMPLE_PYTHON || environmentPython
  for (const block of blocks.filter(candidate => candidate.runs)) {
    if (python === environmentPython && !existsSync(python)) {
      throw new Error(`${python} is missing, so scripts/tools.py set up no environment`)
    }
    const directory = join(workspace, `run_${block.name}`)
    mkdirSync(directory)
    run(python, ['-I', fileOf(block)], {
      cwd: directory,
      timeoutMs: EXAMPLE_RUN_TIMEOUT_MS,
      label: `python of ${describe(block)}`,
    })
  }
}

const COMPILER_OPTIONS_BY_PACKAGE = {
  '@delali/narsil-react-native': {
    module: 'ESNext',
    moduleResolution: 'bundler',
    rootDir: '..',
    types: [],
    baseUrl: '.',
    paths: {
      '@delali/narsil-react-native': ['../src/index.ts'],
      '@delali/narsil-react-native/worklets': ['../src/worklets/index.ts'],
    },
  },
}

function transpiled(typescript, block, fileName) {
  const { outputText, diagnostics = [] } = typescript.transpileModule(block.code, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      module: typescript.ModuleKind.ESNext,
      target: typescript.ScriptTarget.ES2022,
      jsx: typescript.JsxEmit.ReactJSX,
    },
  })
  if (diagnostics.length > 0) {
    const messages = diagnostics.map(diagnostic =>
      typescript.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    )
    throw new Error(`${describe(block)} does not transpile: ${messages.join('; ')}`)
  }
  return outputText
}

function checkTypescript(blocks, packageRoot) {
  requireDistinctNames(blocks)
  const packageName = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).name
  const workspace = mkdtempSync(join(packageRoot, '.readme-examples-'))
  try {
    const fileOf = block => `${block.name}.${block.language === 'tsx' ? 'tsx' : 'ts'}`
    for (const block of blocks) writeFileSync(join(workspace, fileOf(block)), block.code)
    const tsconfig = {
      extends: '../tsconfig.json',
      compilerOptions: {
        noEmit: true,
        rootDir: '.',
        declaration: false,
        declarationMap: false,
        sourceMap: false,
        moduleDetection: 'force',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        jsx: 'react-jsx',
        types: ['node'],
        ...COMPILER_OPTIONS_BY_PACKAGE[packageName],
      },
      include: blocks.map(fileOf),
      exclude: [],
    }
    writeFileSync(join(workspace, 'tsconfig.json'), `${JSON.stringify(tsconfig, null, 2)}\n`)
    const tsc = require.resolve('typescript/bin/tsc', { paths: [packageRoot] })
    run(process.execPath, [tsc, '-p', join(workspace, 'tsconfig.json')], {
      cwd: workspace,
      timeoutMs: EXAMPLE_COMPILE_TIMEOUT_MS,
      label: compileLabel('tsc', blocks, block => join(relative(process.cwd(), workspace), fileOf(block))),
    })
    const runnable = blocks.filter(candidate => candidate.runs)
    const typescript = runnable.length > 0 ? require(require.resolve('typescript', { paths: [packageRoot] })) : null
    for (const block of runnable) {
      const program = `${block.name}.mjs`
      writeFileSync(join(workspace, program), transpiled(typescript, block, fileOf(block)))
      run(process.execPath, [program], {
        cwd: workspace,
        timeoutMs: EXAMPLE_RUN_TIMEOUT_MS,
        label: `node of ${describe(block)}`,
      })
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

function withWorkspace(check) {
  const workspace = mkdtempSync(join(require('node:os').tmpdir(), 'narsil-examples-'))
  try {
    check(workspace)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

function verdictOf(block, { typeCheck = true, execute = true }) {
  if (block.skipped) return 'carries skip'
  if (!typeCheck) return block.runs ? 'runs' : 'waits for the type-check step'
  return block.runs && execute ? 'compiles and runs' : 'compiles'
}

function report(blocks, stages = {}) {
  for (const block of blocks) {
    const verdict = verdictOf(block, stages)
    console.log(`${describe(block)} ${verdict}`)
  }
}

module.exports = { checkGo, checkPython, checkTypescript, report, withWorkspace }

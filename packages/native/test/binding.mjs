import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, sep } from 'node:path'
import { packageDirectory, sanitisedBindingDirectory } from '../toolchain.mjs'

const TEST_TIMEOUT_MS = 1_200_000
const LEAK_SECTION = /^(?=(?:Direct|Indirect) leak of )/m
const MEMORY_ERROR = 'ERROR: AddressSanitizer'
const UNDEFINED_BEHAVIOUR = 'runtime error:'

if (process.platform !== 'linux') {
  console.error('test/binding.mjs checks the Node binding under AddressSanitizer, which it supports only on Linux.')
  process.exit(2)
}

const typescriptDirectory = join(packageDirectory, '..', 'ts')
if (!existsSync(join(typescriptDirectory, 'dist', 'workers', 'entry.mjs'))) {
  console.error(
    'test/binding.mjs needs the TypeScript package built, so that the tests that copy an index onto worker threads load the binding there too. Run pnpm nx run narsil-ts:build first.',
  )
  process.exit(2)
}

execFileSync(process.execPath, [join(packageDirectory, 'build.mjs'), '--host-compiler', '--sanitised'], {
  stdio: 'inherit',
})

const runtime = execFileSync('cc', ['-print-file-name=libasan.so'], { encoding: 'utf8' }).trim()
if (!existsSync(runtime)) {
  console.error(
    `The compiler that built the binding has no AddressSanitizer runtime to preload: it printed ${runtime}.`,
  )
  process.exit(2)
}

const reportDirectory = join(sanitisedBindingDirectory, 'reports')
const suppressions = join(packageDirectory, 'test', 'binding-leaks.supp')
if (packageDirectory.includes(':')) {
  console.error(`The sanitiser options separate fields with a colon, so they cannot hold the path ${packageDirectory}.`)
  process.exit(2)
}
rmSync(reportDirectory, { recursive: true, force: true })
mkdirSync(reportDirectory, { recursive: true })

const run = spawnSync(
  'pnpm',
  ['run', 'test:native', `--execArgv=--require=${join(packageDirectory, 'test', 'exit-on-sigterm.cjs')}`],
  {
    cwd: typescriptDirectory,
    stdio: 'inherit',
    timeout: TEST_TIMEOUT_MS,
    env: {
      ...process.env,
      LD_PRELOAD: runtime,
      ASAN_OPTIONS: `detect_leaks=1:fast_unwind_on_malloc=0:log_path=${join(reportDirectory, 'address')}`,
      LSAN_OPTIONS: `exitcode=0:suppressions=${suppressions}`,
      UBSAN_OPTIONS: `print_stacktrace=1:log_path=${join(reportDirectory, 'undefined')}`,
      NARSIL_NATIVE_CORE_PATH: join(sanitisedBindingDirectory, 'narsil-core.node'),
      NARSIL_REQUIRE_NATIVE_CORE: '1',
    },
  },
)

const ownFrame = `${packageDirectory}${sep}`
const findings = []
for (const name of readdirSync(reportDirectory).sort()) {
  const report = readFileSync(join(reportDirectory, name), 'utf8')
  if (report.includes(MEMORY_ERROR) || report.includes(UNDEFINED_BEHAVIOUR)) {
    findings.push({ name, text: report })
    continue
  }
  for (const section of report.split(LEAK_SECTION)) {
    if (/^(?:Direct|Indirect) leak of /.test(section) && section.includes(ownFrame)) {
      findings.push({ name, text: section })
    }
  }
}

for (const finding of findings) console.error(`${finding.name}:\n${finding.text}`)
if (run.error) console.error(`The TypeScript tests did not finish: ${run.error.message}`)
if (run.status !== 0 || run.error || findings.length > 0) {
  console.error(
    `The TypeScript tests against the sanitised binding exited with ${run.status ?? run.signal}, and the sanitisers reported ${findings.length} problem(s) in the core or the binding.`,
  )
  process.exit(1)
}
console.log('The TypeScript tests passed against the sanitised binding with no memory errors and no leaks')

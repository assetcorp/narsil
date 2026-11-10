import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildDirectory,
  coreSources,
  LANGUAGE_FLAGS,
  MEMORY_SANITISERS,
  SANITISER_FLAGS,
  TEST_FLAGS,
  TEST_LINK_FLAGS,
  testSources,
  warningFlags,
} from '../toolchain.mjs'

const testBuildDirectory = join(buildDirectory, 'test')
mkdirSync(testBuildDirectory, { recursive: true })

const TEST_TIMEOUT_MS = 120_000
const ANALYSIS_THREADS_ONLY = 'analysis-threads'
const ALLOCATION_FAILURES_ONLY = 'allocation-failures'
const ALLOCATION_FAILURE_FLAGS = ['-DNARSIL_ALLOCATION_FAILURE_TESTS']
const ALLOCATION_SITE = /"([^"]+)" ":" "(\d+)"/g
const REFUSED_SITE_PREFIX = 'refused allocation site '
const REFUSED_CALL = /^(.+): \d+ refused calls in (\d+) ms$/gm
const ALLOCATION_PROCESSES = 4
const ALLOCATION_OUTPUT_BYTES = 16 * 1024 * 1024
const MILLISECONDS_PER_SECOND = 1000
const PREPROCESSED_SOURCE_BYTES = 256 * 1024 * 1024
const sanitisers = process.platform === 'linux' ? MEMORY_SANITISERS : 'undefined'

const variants = [
  { name: 'platform-kernels', flags: [] },
  ...(process.arch === 'x64' ? [{ name: 'sse2-kernels', flags: ['-DNARSIL_SSE2_ONLY'] }] : []),
  { name: 'portable-kernels', flags: ['-DNARSIL_PORTABLE_KERNELS'] },
]

function compileTest(name, flags) {
  const binary = join(testBuildDirectory, name)
  execFileSync(
    'cc',
    [
      ...LANGUAGE_FLAGS,
      ...TEST_FLAGS,
      ...warningFlags('cc'),
      ...flags,
      ...TEST_LINK_FLAGS,
      '-o',
      binary,
      ...testSources(),
      ...coreSources(),
      '-lm',
    ],
    { stdio: 'inherit' },
  )
  return binary
}

for (const variant of variants) {
  const binary = compileTest(variant.name, [`-fsanitize=${sanitisers}`, ...SANITISER_FLAGS, ...variant.flags])
  execFileSync(binary, [], { stdio: 'inherit', timeout: TEST_TIMEOUT_MS })
  console.log(`The ${variant.name} test passed under -fsanitize=${sanitisers}`)
}

function allocationSites(flags) {
  const sites = new Set()
  for (const file of coreSources()) {
    const expanded = execFileSync('cc', [...LANGUAGE_FLAGS, ...flags, '-E', file], {
      encoding: 'utf8',
      maxBuffer: PREPROCESSED_SOURCE_BYTES,
    })
    for (const match of expanded.matchAll(ALLOCATION_SITE)) sites.add(`${match[1]}:${match[2]}`)
  }
  return sites
}

function runAllocationPart(binary, part) {
  return new Promise(resolve => {
    execFile(
      binary,
      [ALLOCATION_FAILURES_ONLY, String(part), String(ALLOCATION_PROCESSES)],
      { encoding: 'utf8', timeout: TEST_TIMEOUT_MS, maxBuffer: ALLOCATION_OUTPUT_BYTES },
      (error, stdout, stderr) => resolve({ part, error, stdout, stderr }),
    )
  })
}

function slowestCall(outputs) {
  let slowest = { name: 'no call', milliseconds: -1 }
  for (const output of outputs) {
    for (const match of output.matchAll(REFUSED_CALL)) {
      const milliseconds = Number(match[2])
      if (milliseconds > slowest.milliseconds) slowest = { name: match[1], milliseconds }
    }
  }
  return slowest
}

async function refuseEveryAllocation() {
  const binary = compileTest(ALLOCATION_FAILURES_ONLY, [
    `-fsanitize=${MEMORY_SANITISERS}`,
    ...SANITISER_FLAGS,
    ...ALLOCATION_FAILURE_FLAGS,
  ])
  const started = performance.now()
  const parts = await Promise.all(
    Array.from({ length: ALLOCATION_PROCESSES }, (_, part) => runAllocationPart(binary, part)),
  )
  const seconds = ((performance.now() - started) / MILLISECONDS_PER_SECOND).toFixed(1)
  const stopped = parts.filter(({ error }) => error !== null)
  for (const { part, error, stdout, stderr } of parts) {
    if (error !== null) {
      const reason = error.killed ? `ran past ${TEST_TIMEOUT_MS} ms` : error.message
      console.error(`Process ${part + 1} of ${ALLOCATION_PROCESSES} ${reason}, after printing:\n${stdout}`)
    }
    process.stderr.write(stderr)
  }
  if (stopped.length > 0) throw new Error(`The allocation-failure test stopped after ${seconds} seconds`)
  const outputs = parts.map(({ stdout }) => stdout)
  const refused = new Set()
  for (const line of outputs.join('\n').split('\n')) {
    if (line.startsWith(REFUSED_SITE_PREFIX)) refused.add(line.slice(REFUSED_SITE_PREFIX.length))
  }
  const sites = allocationSites(ALLOCATION_FAILURE_FLAGS)
  const unrefused = [...sites].filter(site => !refused.has(site)).sort()
  if (sites.size === 0 || unrefused.length > 0) {
    throw new Error(
      `No allocation-failure test refuses these core allocation sites:\n${unrefused.join('\n') || 'none were found'}`,
    )
  }
  const slowest = slowestCall(outputs)
  console.log(
    `Every one of the ${sites.size} core allocation sites failed in turn under -fsanitize=${MEMORY_SANITISERS}, in ${seconds} seconds across ${ALLOCATION_PROCESSES} processes, where ${slowest.name} took the longest at ${slowest.milliseconds} ms`,
  )
}

if (process.platform === 'linux') {
  await refuseEveryAllocation()
  const binary = compileTest(ANALYSIS_THREADS_ONLY, ['-fsanitize=thread', '-fno-omit-frame-pointer'])
  execFileSync(binary, [ANALYSIS_THREADS_ONLY], {
    stdio: 'inherit',
    timeout: TEST_TIMEOUT_MS,
    env: { ...process.env, TSAN_OPTIONS: 'halt_on_error=1' },
  })
  console.log('Analysers on separate threads passed under -fsanitize=thread')
}

import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { basename, join, relative } from 'node:path'
import { parseArgs } from 'node:util'
import {
  buildDirectory,
  coreSources,
  FUZZ_SUPPORT_FILES,
  fuzzTargets,
  LANGUAGE_FLAGS,
  MEMORY_SANITISERS,
  packageDirectory,
  SANITISER_FLAGS,
  TEST_FLAGS,
  TEST_LINK_FLAGS,
  warningFlags,
} from '../toolchain.mjs'

const DEFAULT_FUZZ_SECONDS = 60
const FUZZ_INPUT_TIMEOUT_SECONDS = 10
const FUZZ_MEMORY_LIMIT_MB = 2048
const FUZZ_MAX_INPUT_BYTES = 65536
const REPLAY_TIMEOUT_MS = 300_000
const FAILURE_LOG_LINES = 60
const REPLAY_MODE = 'replay'
const FUZZ_MODE = 'fuzz'

const fuzzDirectory = join(packageDirectory, 'fuzz')
const corpusDirectory = join(fuzzDirectory, 'corpus')
const REPLAY_SOURCE_NAME = 'replay.c'
const supportSources = FUZZ_SUPPORT_FILES.filter(name => name !== REPLAY_SOURCE_NAME).map(name =>
  join(fuzzDirectory, name),
)
const replaySource = join(fuzzDirectory, REPLAY_SOURCE_NAME)

const fuzzCompiler = process.env.NARSIL_FUZZ_CC ?? 'clang'

const MODES = {
  [FUZZ_MODE]: {
    compiler: fuzzCompiler,
    flags: [`-fsanitize=fuzzer-no-link,${MEMORY_SANITISERS}`],
    linkFlags: [`-fsanitize=fuzzer,${MEMORY_SANITISERS}`],
  },
  [REPLAY_MODE]: {
    compiler: fuzzCompiler,
    flags: [`-fsanitize=${MEMORY_SANITISERS}`],
    linkFlags: [`-fsanitize=${MEMORY_SANITISERS}`],
  },
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: packageDirectory, stdio: 'inherit', ...options })
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code: code ?? 1, signal }))
  })
}

async function runEach(jobs, limit) {
  let next = 0
  const failures = []
  async function worker() {
    for (;;) {
      const index = next++
      if (index >= jobs.length) return
      const result = await jobs[index]()
      if (result) failures.push(result)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker))
  return failures
}

function objectPath(objects, source) {
  return join(objects, `${relative(packageDirectory, source).replace(/\.c$/, '').replaceAll('/', '-')}.o`)
}

async function compileObjects(mode, sources) {
  const { compiler, flags } = MODES[mode]
  const objects = join(buildDirectory, 'fuzz', mode, 'objects')
  mkdirSync(objects, { recursive: true })
  const shared = [...LANGUAGE_FLAGS, ...TEST_FLAGS, ...warningFlags(compiler), ...flags, ...SANITISER_FLAGS]
  const failures = await runEach(
    sources.map(source => async () => {
      const { code } = await run(compiler, [...shared, '-c', source, '-o', objectPath(objects, source)])
      return code === 0 ? null : relative(packageDirectory, source)
    }),
    availableParallelism(),
  )
  if (failures.length > 0) throw new Error(`These sources do not compile: ${failures.join(', ')}`)
  return sources.map(source => objectPath(objects, source))
}

async function link(mode, target, objects) {
  const { compiler, linkFlags } = MODES[mode]
  const binary = join(buildDirectory, 'fuzz', mode, target)
  const { code } = await run(compiler, [...linkFlags, ...TEST_LINK_FLAGS, '-o', binary, ...objects, '-lm'])
  if (code !== 0) throw new Error(`The ${target} fuzz target does not link`)
  return binary
}

function targetCorpus(target) {
  const directory = join(corpusDirectory, target)
  mkdirSync(directory, { recursive: true })
  return directory
}

async function replay(targets) {
  const core = await compileObjects(REPLAY_MODE, [...coreSources(), ...supportSources, replaySource])
  const targetObjects = await compileObjects(
    REPLAY_MODE,
    targets.map(target => join(fuzzDirectory, `${target}.c`)),
  )
  for (const [index, target] of targets.entries()) {
    const binary = await link(REPLAY_MODE, target, [...core, targetObjects[index]])
    const { code, signal } = await run(binary, [targetCorpus(target)], { timeout: REPLAY_TIMEOUT_MS })
    if (code !== 0 || signal) throw new Error(`The ${target} corpus fails its replay`)
    console.log(`The ${target} corpus replayed under -fsanitize=${MEMORY_SANITISERS}`)
  }
}

async function fuzz(targets, seconds) {
  const core = await compileObjects(FUZZ_MODE, [...coreSources(), ...supportSources])
  const targetObjects = await compileObjects(
    FUZZ_MODE,
    targets.map(target => join(fuzzDirectory, `${target}.c`)),
  )
  const binaries = []
  for (const [index, target] of targets.entries()) {
    binaries.push(await link(FUZZ_MODE, target, [...core, targetObjects[index]]))
  }
  const artifacts = join(buildDirectory, 'fuzz', 'artifacts')
  const logs = join(buildDirectory, 'fuzz', 'logs')
  mkdirSync(artifacts, { recursive: true })
  mkdirSync(logs, { recursive: true })
  const failures = await runEach(
    targets.map((target, index) => async () => {
      const discovered = join(buildDirectory, 'fuzz', 'discovered', target)
      mkdirSync(discovered, { recursive: true })
      const logPath = join(logs, `${target}.log`)
      const log = openSync(logPath, 'w')
      const { code, signal } = await run(
        binaries[index],
        [
          `-max_total_time=${seconds}`,
          `-timeout=${FUZZ_INPUT_TIMEOUT_SECONDS}`,
          `-rss_limit_mb=${FUZZ_MEMORY_LIMIT_MB}`,
          `-max_len=${FUZZ_MAX_INPUT_BYTES}`,
          `-artifact_prefix=${join(artifacts, `${target}-`)}`,
          '-use_value_profile=1',
          '-print_final_stats=1',
          discovered,
          targetCorpus(target),
        ],
        { stdio: ['ignore', log, log] },
      )
      closeSync(log)
      if (code === 0 && !signal) {
        console.log(`The ${target} fuzz target ran for ${seconds} seconds without a failure`)
        return null
      }
      const lines = readFileSync(logPath, 'utf8').trimEnd().split('\n')
      console.error(`\nThe ${target} fuzz target fails; ${logPath} holds its log:\n`)
      console.error(lines.slice(-FAILURE_LOG_LINES).join('\n'))
      return target
    }),
    availableParallelism(),
  )
  if (failures.length > 0) {
    throw new Error(`These fuzz targets fail, and ${artifacts} holds each failing input: ${failures.join(', ')}`)
  }
}

const { values, positionals } = parseArgs({
  options: { seconds: { type: 'string' }, replay: { type: 'boolean' } },
  allowPositionals: true,
})
const known = fuzzTargets().map(file => basename(file, '.c'))
const unknown = positionals.filter(target => !known.includes(target))
if (unknown.length > 0) throw new Error(`There is no fuzz target called ${unknown.join(', ')}`)
const targets = positionals.length > 0 ? positionals : known
if (!existsSync(corpusDirectory)) mkdirSync(corpusDirectory, { recursive: true })
if (values.replay) {
  await replay(targets)
} else {
  const seconds = Number(values.seconds ?? DEFAULT_FUZZ_SECONDS)
  if (!Number.isInteger(seconds) || seconds <= 0) throw new Error('--seconds takes a positive whole number')
  await fuzz(targets, seconds)
  console.log(`Every fuzz target ran for ${seconds} seconds without a failure`)
}

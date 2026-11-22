import { spawn } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const packageDirectory = fileURLToPath(new URL('..', import.meta.url))
const campaignDirectory = join(packageDirectory, 'fault-campaign')
const seedDirectory = join(campaignDirectory, 'failing-seeds')
const logDirectory = join(campaignDirectory, 'logs')
const TEST_FILE = 'src/__tests__/e2e/cluster-faults/seeded-faults.test.ts'
const RUN_TIMEOUT_MS = 8 * 60_000
const STOP_GRACE_MS = 30_000
const PASSES_TO_RETIRE_A_SEED = 3
const MAX_SEED = 2 ** 31
const SEED_FILE_PATTERN = /^(\d+)\.json$/

function seedPath(seed) {
  return join(seedDirectory, `${seed}.json`)
}

function savedSeeds() {
  mkdirSync(seedDirectory, { recursive: true })
  return readdirSync(seedDirectory)
    .map(name => SEED_FILE_PATTERN.exec(name)?.[1])
    .filter(seed => seed !== undefined)
    .map(Number)
    .filter(seed => Number.isSafeInteger(seed) && seed >= 0 && seed < MAX_SEED)
    .sort((left, right) => left - right)
}

function passesSinceFailure(seed) {
  try {
    const saved = JSON.parse(readFileSync(seedPath(seed), 'utf8'))
    return Number.isSafeInteger(saved.passesSinceFailure) ? saved.passesSinceFailure : 0
  } catch {
    return 0
  }
}

function saveSeed(seed, passes) {
  mkdirSync(seedDirectory, { recursive: true })
  writeFileSync(seedPath(seed), `${JSON.stringify({ seed, passesSinceFailure: passes })}\n`)
}

function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal)
  } catch {
    child.kill(signal)
  }
}

function runSeed(seed) {
  mkdirSync(logDirectory, { recursive: true })
  const logPath = join(logDirectory, `seed-${seed}.log`)
  const log = openSync(logPath, 'w')
  return new Promise(resolve => {
    const child = spawn('pnpm', ['exec', 'vitest', 'run', TEST_FILE, '--silent=false'], {
      cwd: packageDirectory,
      env: { ...process.env, NARSIL_FAULT_CAMPAIGN: '1', NARSIL_FAULT_SEED: String(seed) },
      stdio: ['ignore', log, log],
      detached: true,
    })
    let timedOut = false
    const finished = false
    let forceTimer = null
    const timer = setTimeout(() => {
      timedOut = true
      signalGroup(child, 'SIGTERM')
      forceTimer = setTimeout(() => signalGroup(child, 'SIGKILL'), STOP_GRACE_MS)
    }, RUN_TIMEOUT_MS)
    const finish = passed => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (forceTimer !== null) clearTimeout(forceTimer)
      closeSync(log)
      if (timedOut)
        writeFileSync(logPath, `\nThe run passed its ${RUN_TIMEOUT_MS} ms limit and was stopped\n`, { flag: 'a' })
      if (passed) rmSync(logPath, { force: true })
      resolve(passed)
    }
    child.once('error', () => finish(false))
    child.once('close', code => finish(code === 0 && !timedOut))
  })
}

function hasTimeFor(startedAt, budgetMs) {
  return Date.now() - startedAt + RUN_TIMEOUT_MS <= budgetMs
}

async function replay(budgetMs) {
  const startedAt = Date.now()
  const seeds = savedSeeds()
  const failing = []
  console.log(`Replaying ${seeds.length} saved seeds`)
  for (const [at, seed] of seeds.entries()) {
    if (!hasTimeFor(startedAt, budgetMs)) {
      console.log(`The time budget left ${seeds.length - at} saved seeds for the next run`)
      break
    }
    if (await runSeed(seed)) {
      const passes = passesSinceFailure(seed) + 1
      if (passes >= PASSES_TO_RETIRE_A_SEED) rmSync(seedPath(seed), { force: true })
      else saveSeed(seed, passes)
      console.log(`seed ${seed} passed, ${passes} passes in a row`)
    } else {
      saveSeed(seed, 0)
      failing.push(seed)
      console.log(`seed ${seed} still fails`)
    }
  }
  return failing
}

async function explore(budgetMs) {
  const startedAt = Date.now()
  const failing = []
  while (hasTimeFor(startedAt, budgetMs)) {
    const seed = randomInt(0, MAX_SEED)
    if (await runSeed(seed)) {
      console.log(`seed ${seed} passed`)
    } else {
      saveSeed(seed, 0)
      failing.push(seed)
      console.log(`seed ${seed} failed`)
    }
  }
  return failing
}

const { values } = parseArgs({
  options: {
    replay: { type: 'boolean', default: false },
    minutes: { type: 'string' },
  },
})
const minutes = Number(values.minutes)
if (!Number.isFinite(minutes) || minutes * 60_000 < RUN_TIMEOUT_MS) {
  console.error(`--minutes must give at least ${RUN_TIMEOUT_MS / 60_000} minutes, the limit of one run`)
  process.exit(2)
}
const failing = values.replay ? await replay(minutes * 60_000) : await explore(minutes * 60_000)
if (failing.length > 0) {
  console.error(
    `These seeds fail; replay one with NARSIL_FAULT_CAMPAIGN=1 NARSIL_FAULT_SEED=<seed>: ${failing.join(', ')}`,
  )
  process.exit(1)
}

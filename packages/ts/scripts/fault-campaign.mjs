import { fork } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { closeSync, constants, openSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  MAX_MINUTES,
  MAX_SEED,
  MIN_MINUTES,
  PASSES_TO_RETIRE_A_SEED,
  REPLAY_SHARE_OF_BUDGET,
  RUN_BUDGET_MS,
} from './fault-campaign/constants.mjs'
import { describeFailure, recordOutcome, startOutcomes } from './fault-campaign/outcomes.mjs'
import { ensureDirectory, readSeeds, saveSeed } from './fault-campaign/seeds.mjs'

const packageDirectory = fileURLToPath(new URL('..', import.meta.url))
const campaignDirectory = process.env.NARSIL_FAULT_CAMPAIGN_DIRECTORY ?? join(packageDirectory, 'fault-campaign')
const seedDirectory = join(campaignDirectory, 'failing-seeds')
const logDirectory = join(campaignDirectory, 'logs')
const supervisorPath = fileURLToPath(new URL('./fault-campaign/supervisor.mjs', import.meta.url))
let interrupted = false
let active = null
let outcomes = []

function interrupt() {
  interrupted = true
  if (active?.connected) active.disconnect()
  process.exitCode = 1
}

process.on('SIGINT', interrupt)
process.on('SIGTERM', interrupt)

async function runSeed(seed) {
  const logPath = join(logDirectory, `seed-${seed}.log`)
  rmSync(logPath, { force: true })
  const log = openSync(logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  console.log(`Starting seed ${seed}`)
  try {
    return await new Promise(resolve => {
      const child = fork(supervisorPath, [String(seed)], {
        cwd: packageDirectory,
        stdio: ['ignore', log, log, 'ipc'],
        detached: true,
      })
      active = child
      let reported = false
      child.on('message', message => {
        if (message?.passed === true) reported = true
      })
      child.once('error', error => {
        console.error(error)
        resolve(false)
      })
      child.once('close', code => {
        active = null
        resolve(reported && code === 0 && !interrupted)
      })
    })
  } finally {
    closeSync(log)
  }
}

async function runAndRecord(seed, saved) {
  const passesInARow = saved?.passesInARow ?? 0
  const record = { seed, lastStartedAt: Date.now(), pending: true, passesInARow }
  saveSeed(seedDirectory, record)
  const passed = await runSeed(seed)
  const logPath = join(logDirectory, `seed-${seed}.log`)
  if (passed) rmSync(logPath, { force: true })
  else if (!interrupted)
    recordOutcome(campaignDirectory, outcomes, { seed, result: 'failed', ...describeFailure(seed, logPath) })
  if (passed && saved === undefined) {
    rmSync(join(seedDirectory, `${seed}.json`), { force: true })
    console.log(`seed ${seed} passed`)
  } else if (passed && passesInARow + 1 >= PASSES_TO_RETIRE_A_SEED) {
    rmSync(join(seedDirectory, `${seed}.json`), { force: true })
    recordOutcome(campaignDirectory, outcomes, { seed, result: 'retired' })
    console.log(`seed ${seed} passed ${PASSES_TO_RETIRE_A_SEED} times in a row, so the campaign retires it`)
  } else {
    const passes = passed ? passesInARow + 1 : 0
    saveSeed(seedDirectory, { ...record, pending: false, passed, passesInARow: passes })
    console.log(`seed ${seed} ${passed ? `passed, ${passes} of ${PASSES_TO_RETIRE_A_SEED} passes in a row` : 'failed'}`)
  }
  return passed
}

async function campaign(replayOnly, deadline) {
  ensureDirectory(campaignDirectory)
  ensureDirectory(seedDirectory)
  ensureDirectory(logDirectory)
  outcomes = startOutcomes(campaignDirectory)
  const saved = readSeeds(seedDirectory)
  const known = new Set(saved.map(record => record.seed))
  const replayDeadline = replayOnly
    ? deadline
    : performance.now() + (deadline - performance.now()) * REPLAY_SHARE_OF_BUDGET
  const fits = limit => !interrupted && performance.now() + RUN_BUDGET_MS <= limit
  const failing = []
  let replayed = 0
  let completed = 0
  console.log(`Replaying ${saved.length} saved seeds, oldest first, before trying new seeds`)
  while (replayed < saved.length && fits(replayDeadline)) {
    const record = saved[replayed]
    replayed += 1
    if (!(await runAndRecord(record.seed, record))) failing.push(record.seed)
    completed += 1
  }
  if (replayed < saved.length)
    console.log(`The replay share of the budget left ${saved.length - replayed} saved seeds for the next campaign`)
  while (!replayOnly && fits(deadline)) {
    const seed = randomInt(0, MAX_SEED)
    if (known.has(seed)) continue
    known.add(seed)
    if (!(await runAndRecord(seed, undefined))) failing.push(seed)
    completed += 1
  }
  if (completed === 0 && (!replayOnly || saved.length > 0)) throw new Error('The budget allowed no completed seeds')
  if (failing.length > 0) {
    console.error(`Failing seeds: ${failing.join(', ')}. Replay with NARSIL_FAULT_CAMPAIGN=1 NARSIL_FAULT_SEED=<seed>`)
    process.exitCode = 1
  }
}

try {
  const { values } = parseArgs({
    options: {
      replay: { type: 'boolean', default: false },
      minutes: { type: 'string' },
      deadline: { type: 'string' },
    },
  })
  const minutes = Number(values.minutes)
  if (
    !/^\d+(\.\d+)?$/.test(values.minutes ?? '') ||
    !Number.isFinite(minutes) ||
    minutes < MIN_MINUTES ||
    minutes > MAX_MINUTES
  )
    throw new Error(`--minutes must be between ${MIN_MINUTES} and ${MAX_MINUTES}`)
  let budgetMs = minutes * 60_000
  if (values.deadline !== undefined) {
    const deadline = Number(values.deadline)
    if (!/^\d+$/.test(values.deadline) || !Number.isSafeInteger(deadline) || deadline <= Date.now())
      throw new Error('--deadline must be a future Unix timestamp in milliseconds')
    budgetMs = Math.min(budgetMs, deadline - Date.now())
  }
  await campaign(values.replay, performance.now() + budgetMs)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 2
}

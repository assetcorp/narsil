import { fork } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { closeSync, constants, openSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { MAX_MINUTES, MAX_SEED, MIN_MINUTES, RUN_BUDGET_MS } from './fault-campaign/constants.mjs'
import { ensureDirectory, readSeeds, saveSeed } from './fault-campaign/seeds.mjs'

const packageDirectory = fileURLToPath(new URL('..', import.meta.url))
const campaignDirectory = process.env.NARSIL_FAULT_CAMPAIGN_DIRECTORY ?? join(packageDirectory, 'fault-campaign')
const seedDirectory = join(campaignDirectory, 'failing-seeds')
const logDirectory = join(campaignDirectory, 'logs')
const supervisorPath = fileURLToPath(new URL('./fault-campaign/supervisor.mjs', import.meta.url))
let interrupted = false
let active = null

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

async function campaign(replayOnly, deadline) {
  ensureDirectory(campaignDirectory)
  ensureDirectory(seedDirectory)
  ensureDirectory(logDirectory)
  const saved = readSeeds(seedDirectory)
  const known = new Set(saved.map(record => record.seed))
  const failing = []
  let replayed = 0
  let completed = 0
  console.log(`Replaying ${saved.length} saved seeds before trying new seeds`)
  while (!interrupted && performance.now() + RUN_BUDGET_MS <= deadline) {
    const previous = saved[replayed]
    if (previous === undefined && replayOnly) break
    const seed = previous?.seed ?? randomInt(0, MAX_SEED)
    const path = join(seedDirectory, `${seed}.json`)
    const existed = known.has(seed)
    const record = { seed, lastStartedAt: Date.now(), pending: true }
    saveSeed(seedDirectory, record)
    const passed = await runSeed(seed)
    completed += 1
    if (passed && !existed) rmSync(path, { force: true })
    else saveSeed(seedDirectory, { ...record, pending: false, passed })
    if (!passed) {
      failing.push(seed)
      known.add(seed)
    } else rmSync(join(logDirectory, `seed-${seed}.log`), { force: true })
    console.log(`seed ${seed} ${passed ? 'passed' : 'failed'}`)
    if (previous !== undefined) replayed += 1
  }
  if (replayed < saved.length)
    console.log(`The budget left ${saved.length - replayed} saved seeds for the next campaign`)
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

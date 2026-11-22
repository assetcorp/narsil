import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import {
  CLEANUP_TIMEOUT_MS,
  MAX_RESOURCE_PREFIX_LENGTH,
  MAX_SEED,
  PROCESS_POLL_MS,
  RUN_TIMEOUT_MS,
  STOP_GRACE_MS,
} from './constants.mjs'

const execute = promisify(execFile)
const seed = process.argv[2]
if (!/^(0|[1-9]\d*)$/.test(seed ?? '') || Number(seed) >= MAX_SEED || !process.connected)
  throw new Error('The campaign runner must start the supervisor with a valid seed and an IPC channel')
const prefix = `${process.env.NARSIL_FAULT_RESOURCE_PREFIX ?? 'narsil-fault-campaign'}-${randomUUID().replaceAll('-', '')}`
if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(prefix) || prefix.length > MAX_RESOURCE_PREFIX_LENGTH)
  throw new Error('Invalid resource prefix')
let stopping = false
let timedOut = false
const temporaryDirectory = mkdtempSync(join(tmpdir(), `${prefix}-`))
const child = spawn(
  'pnpm',
  [
    'exec',
    'vitest',
    'run',
    'src/__tests__/e2e/cluster-faults/seeded-faults.test.ts',
    '--silent=false',
    '--reporter=verbose',
  ],
  {
    env: {
      ...process.env,
      TMPDIR: temporaryDirectory,
      NARSIL_FAULT_CAMPAIGN: '1',
      NARSIL_FAULT_SEED: seed,
      NARSIL_FAULT_RESOURCE_PREFIX: prefix,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true,
  },
)

function signalGroup(signal) {
  if (child.pid === undefined) return false
  try {
    process.kill(-child.pid, signal)
    return true
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
    return false
  }
}

async function cleanup() {
  const containers = [0, 1, 2].map(member => `${prefix}-etcd-${member}`)
  const problems = []
  await execute('docker', ['rm', '--force', ...containers], { timeout: CLEANUP_TIMEOUT_MS }).catch(error => {
    const lines = error.stderr?.trim().split('\n') ?? []
    if (
      lines.length === 0 ||
      !lines.every(line => containers.some(name => line.endsWith(`No such container: ${name}`)))
    )
      problems.push(error)
  })
  await execute('docker', ['network', 'rm', `${prefix}-net`], { timeout: CLEANUP_TIMEOUT_MS }).catch(error => {
    if (!error.stderr?.includes('not found')) problems.push(error)
  })
  await rm(temporaryDirectory, { recursive: true, force: true }).catch(error => problems.push(error))
  if (problems.length > 0) throw new AggregateError(problems, 'The campaign could not remove every resource')
}

async function finish(passed) {
  if (stopping) return
  stopping = true
  clearTimeout(timer)
  try {
    signalGroup('SIGCONT')
    if (signalGroup('SIGTERM')) {
      const deadline = performance.now() + STOP_GRACE_MS
      while (performance.now() < deadline && signalGroup(0)) await sleep(PROCESS_POLL_MS)
      signalGroup('SIGKILL')
    }
    await cleanup()
    if (timedOut) console.error(`The seed exceeded its ${RUN_TIMEOUT_MS} ms limit`)
    if (process.connected) await new Promise(resolve => process.send({ passed: passed && !timedOut }, () => resolve()))
    process.exitCode = passed && !timedOut ? 0 : 1
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    if (process.connected) process.disconnect()
  }
}

const timer = setTimeout(() => {
  timedOut = true
  void finish(false)
}, RUN_TIMEOUT_MS)
process.on('disconnect', () => void finish(false))
process.on('SIGINT', () => void finish(false))
process.on('SIGTERM', () => void finish(false))
child.once('error', error => {
  console.error(error)
  void finish(false)
})
child.once('close', code => void finish(code === 0))

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { MAX_OUTCOME_LOG_BYTES } from './constants.mjs'

export const OUTCOMES_FILE = 'outcomes.json'

export const CAMPAIGN_CHECKS = [
  'the cluster acknowledges writes',
  'every copy equals its primary',
  'every acknowledged write survives',
  'every search outside a fault answers',
  'every node answers a search with every stored document',
  'every write outside a fault answers',
  'enough writes complete outside a fault',
  'no write is far slower than the median',
  'no node leaves sockets open at shutdown',
]

const FAILURES_OUTSIDE_A_CHECK = [
  [/The cluster did not heal within \d+ ms/, 'the cluster heals after each fault'],
  [/Slot \d+ did not start within \d+ ms/, 'every node starts'],
  [/Slot \d+ exited with code \S+ before it started/, 'every node starts'],
  [/Slot \d+ did not stop cleanly/, 'every node stops cleanly'],
  [/The seed exceeded its \d+ ms limit/, 'the seed finishes within its time limit'],
]

const SETTINGS_LINE =
  /^NARSIL_FAULT_SEED=(\d+) NARSIL_FAULT_CAMPAIGN=1(?: NARSIL_FAULT_RUST_SLOTS=(\d(?:,\d)*))?: (tcp|grpc) carrier( over TLS)?, /m

function readLog(path) {
  let descriptor
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return ''
  }
  try {
    const stat = fstatSync(descriptor)
    if (!stat.isFile()) return ''
    const length = Math.min(stat.size, MAX_OUTCOME_LOG_BYTES)
    const buffer = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const count = readSync(descriptor, buffer, read, length - read, stat.size - length + read)
      if (count === 0) break
      read += count
    }
    return buffer.subarray(0, read).toString('utf8')
  } finally {
    closeSync(descriptor)
  }
}

export function describeFailure(seed, logPath) {
  const log = readLog(logPath)
  const settings = SETTINGS_LINE.exec(log)
  const matchesSeed = settings !== null && Number(settings[1]) === seed
  const checks = CAMPAIGN_CHECKS.filter(check => log.includes(`AssertionError: ${check}: `))
  for (const [pattern, check] of FAILURES_OUTSIDE_A_CHECK) {
    if (pattern.test(log) && !checks.includes(check)) checks.push(check)
  }
  return {
    carrier: matchesSeed ? settings[3] : null,
    tls: matchesSeed ? settings[4] !== undefined : null,
    rustSlots: matchesSeed ? (settings[2] ?? '') : null,
    checks,
  }
}

export function startOutcomes(directory) {
  rmSync(join(directory, OUTCOMES_FILE), { force: true })
  return []
}

export function recordOutcome(directory, outcomes, outcome) {
  outcomes.push(outcome)
  const temporary = join(directory, `.outcomes-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, `${JSON.stringify(outcomes)}\n`, { flag: 'wx', mode: 0o600, flush: true })
    renameSync(temporary, join(directory, OUTCOMES_FILE))
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function readOutcomes(directory) {
  const text = readFileSync(join(directory, OUTCOMES_FILE), 'utf8')
  const parsed = JSON.parse(text)
  if (!Array.isArray(parsed)) throw new Error(`${OUTCOMES_FILE} must hold an array`)
  return parsed
}

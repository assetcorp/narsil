import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { MAX_SEED, MAX_SEED_FILE_BYTES, PASSES_TO_RETIRE_A_SEED } from './constants.mjs'

export function ensureDirectory(path) {
  mkdirSync(path, { recursive: true })
  if (!lstatSync(path).isDirectory()) throw new Error(`Expected a directory at ${path}`)
}

function savedRecord(path) {
  const unreadable = { lastStartedAt: 0, passesInARow: 0 }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || stat.size > MAX_SEED_FILE_BYTES) return unreadable
    const saved = JSON.parse(readFileSync(descriptor, 'utf8'))
    const timestamp = saved?.lastStartedAt
    const passes = saved?.passesInARow
    return {
      lastStartedAt: Number.isSafeInteger(timestamp) && timestamp >= 0 && timestamp <= Date.now() ? timestamp : 0,
      passesInARow: Number.isSafeInteger(passes) && passes >= 0 && passes < PASSES_TO_RETIRE_A_SEED ? passes : 0,
    }
  } catch {
    return unreadable
  } finally {
    closeSync(descriptor)
  }
}

export function readSeeds(directory) {
  const seeds = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const match = /^(0|[1-9]\d*)\.json$/.exec(entry.name)
    if (match === null) continue
    const seed = Number(match[1])
    if (!Number.isSafeInteger(seed) || seed >= MAX_SEED) continue
    if (!entry.isFile()) throw new Error(`Saved seed ${entry.name} must be a regular file`)
    seeds.push({ seed, ...savedRecord(join(directory, entry.name)) })
  }
  return seeds.sort((left, right) => left.lastStartedAt - right.lastStartedAt || left.seed - right.seed)
}

export function saveSeed(directory, record) {
  const temporary = join(directory, `.seed-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600, flush: true })
    renameSync(temporary, join(directory, `${record.seed}.json`))
  } finally {
    rmSync(temporary, { force: true })
  }
}

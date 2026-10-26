import { close, openSync, readFileSync } from 'node:fs'
import { readdir, readFile, readlink, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { endianness } from 'node:os'
import { dirname } from 'node:path'
import { DIRECTORY_LOCK_PROCESS_START_TOLERANCE_MS } from './constants'

interface RecordedProcess {
  pid: number
  processStartMs: number | null
}

type ProcessIdentity =
  | { kind: 'process'; startMs: number }
  | { kind: 'thread' }
  | { kind: 'exited' }
  | { kind: 'unknown' }

const AUXV_CLOCK_TICKS_TYPE = 17n
const AUXV_END_TYPE = 0n
const THIRTY_TWO_BIT_ARCHITECTURES = new Set(['arm', 'ia32', 'mips', 'mipsel', 'ppc'])
const FIRST_STAT_FIELD_AFTER_COMMAND = 3
const STAT_STATE_FIELD = 3
const STAT_START_TIME_FIELD = 22
const EXITED_STATES = new Set(['Z', 'X', 'x'])
const UNKNOWN: ProcessIdentity = { kind: 'unknown' }

let clockTicksPerSecond: Promise<number | null> | null = null

function errnoOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code
}

function readWord(bytes: Buffer, offset: number, wordBytes: number, littleEndian: boolean): bigint {
  if (wordBytes === 8) return littleEndian ? bytes.readBigUInt64LE(offset) : bytes.readBigUInt64BE(offset)
  return BigInt(littleEndian ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset))
}

async function readClockTicksPerSecond(): Promise<number | null> {
  const auxv = await readFile('/proc/self/auxv')
  const wordBytes = THIRTY_TWO_BIT_ARCHITECTURES.has(process.arch) ? 4 : 8
  const littleEndian = endianness() === 'LE'
  for (let offset = 0; offset + 2 * wordBytes <= auxv.length; offset += 2 * wordBytes) {
    const type = readWord(auxv, offset, wordBytes, littleEndian)
    if (type === AUXV_END_TYPE) return null
    if (type === AUXV_CLOCK_TICKS_TYPE) {
      const ticks = Number(readWord(auxv, offset + wordBytes, wordBytes, littleEndian))
      return ticks > 0 ? ticks : null
    }
  }
  return null
}

function clockTicks(): Promise<number | null> {
  clockTicksPerSecond ??= readClockTicksPerSecond().catch(() => null)
  return clockTicksPerSecond
}

function threadGroupOf(status: string): number | null {
  const leader = /^Tgid:\s*(\d+)\s*$/m.exec(status)?.[1]
  return leader === undefined ? null : Number(leader)
}

function statField(fieldsAfterCommand: string[], field: number): string | undefined {
  return fieldsAfterCommand[field - FIRST_STAT_FIELD_AFTER_COMMAND]
}

function signalReaches(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return errnoOf(err) === 'EPERM'
  }
}

async function identifyProcess(pid: number): Promise<ProcessIdentity> {
  try {
    const [status, stat, ticksPerSecond] = await Promise.all([
      readFile(`/proc/${pid}/status`, 'utf8'),
      readFile(`/proc/${pid}/stat`, 'utf8'),
      clockTicks(),
    ])
    const leader = threadGroupOf(status)
    if (leader === null) return UNKNOWN
    if (leader !== pid) return { kind: 'thread' }
    const commandEnd = stat.lastIndexOf(')')
    if (commandEnd < 0) return UNKNOWN
    const fieldsAfterCommand = stat
      .slice(commandEnd + 1)
      .trim()
      .split(/\s+/)
    const state = statField(fieldsAfterCommand, STAT_STATE_FIELD)
    if (state !== undefined && EXITED_STATES.has(state)) return { kind: 'exited' }
    const startTicks = Number(statField(fieldsAfterCommand, STAT_START_TIME_FIELD))
    const uptimeSeconds = Number.parseFloat(readFileSync('/proc/uptime', 'utf8'))
    const nowMs = Date.now()
    if (ticksPerSecond === null || !Number.isFinite(startTicks) || !Number.isFinite(uptimeSeconds)) return UNKNOWN
    return { kind: 'process', startMs: Math.round(nowMs - (uptimeSeconds - startTicks / ticksPerSecond) * 1000) }
  } catch {
    return UNKNOWN
  }
}

async function descriptorTargets(pid: number): Promise<string[] | null> {
  const descriptorDirectory = `/proc/${pid}/fd`
  let descriptors: string[]
  try {
    descriptors = await readdir(descriptorDirectory)
  } catch {
    return null
  }
  const targets: string[] = []
  for (const descriptor of descriptors) {
    try {
      targets.push(await readlink(`${descriptorDirectory}/${descriptor}`))
    } catch (err) {
      if (errnoOf(err) !== 'ENOENT') return null
    }
  }
  return targets
}

async function holdsFileInDirectoryOf(pid: number, lockPath: string): Promise<boolean> {
  const targets = await descriptorTargets(pid)
  if (targets === null) return false
  const directory = await realpath(dirname(lockPath)).catch(() => null)
  if (directory === null) return false
  const inside = directory.endsWith('/') ? directory : `${directory}/`
  return targets.some(target => target === directory || target.startsWith(inside))
}

export async function holderIsLive(holder: RecordedProcess, self: RecordedProcess, lockPath: string): Promise<boolean> {
  if (holder.pid === self.pid) {
    if (holder.processStartMs === null || self.processStartMs === null) return false
    if (Math.abs(holder.processStartMs - self.processStartMs) <= DIRECTORY_LOCK_PROCESS_START_TOLERANCE_MS) return true
    return holdsFileInDirectoryOf(holder.pid, lockPath)
  }
  if (!signalReaches(holder.pid)) return false
  const found = await identifyProcess(holder.pid)
  if (found.kind === 'thread' || found.kind === 'exited') return false
  if (found.kind === 'unknown') return signalReaches(holder.pid)
  if (holder.processStartMs === null) return true
  if (found.startMs - holder.processStartMs <= DIRECTORY_LOCK_PROCESS_START_TOLERANCE_MS) return true
  return holdsFileInDirectoryOf(holder.pid, lockPath)
}

export function holdDirectoryOpen(directory: string): () => void {
  if (process.platform !== 'linux') return () => undefined
  const descriptor = openSync(directory, 'r')
  return () => close(descriptor, () => undefined)
}

export async function removeStaleLock(
  lockPath: string,
  asidePath: string,
  isStale: (text: string) => boolean,
): Promise<void> {
  try {
    await rename(lockPath, asidePath)
  } catch (err) {
    if (errnoOf(err) === 'ENOENT') return
    throw err
  }
  try {
    const moved = await readFile(asidePath, 'utf8')
    if (!isStale(moved)) {
      await writeFile(lockPath, moved, { flag: 'wx' }).catch(err => {
        if (errnoOf(err) !== 'EEXIST') throw err
      })
    }
  } finally {
    await unlink(asidePath).catch(() => undefined)
  }
}

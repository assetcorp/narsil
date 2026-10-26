import { readFile } from 'node:fs/promises'
import { endianness } from 'node:os'
import { DIRECTORY_LOCK_PROCESS_START_TOLERANCE_MS } from './constants'

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
    return (err as NodeJS.ErrnoException | null)?.code === 'EPERM'
  }
}

async function identifyProcess(pid: number): Promise<ProcessIdentity> {
  try {
    const [status, stat, uptime, ticksPerSecond] = await Promise.all([
      readFile(`/proc/${pid}/status`, 'utf8'),
      readFile(`/proc/${pid}/stat`, 'utf8'),
      readFile('/proc/uptime', 'utf8'),
      clockTicks(),
    ])
    const nowMs = Date.now()
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
    const uptimeSeconds = Number.parseFloat(uptime)
    if (ticksPerSecond === null || !Number.isFinite(startTicks) || !Number.isFinite(uptimeSeconds)) return UNKNOWN
    return { kind: 'process', startMs: Math.round(nowMs - (uptimeSeconds - startTicks / ticksPerSecond) * 1000) }
  } catch {
    return UNKNOWN
  }
}

export async function recordedProcessRuns(pid: number, recordedStartMs: number | null): Promise<boolean> {
  if (!signalReaches(pid)) return false
  const found = await identifyProcess(pid)
  if (found.kind === 'thread' || found.kind === 'exited') return false
  if (found.kind === 'unknown' || recordedStartMs === null) return true
  return found.startMs - recordedStartMs <= DIRECTORY_LOCK_PROCESS_START_TOLERANCE_MS
}

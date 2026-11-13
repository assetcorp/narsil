import { existsSync, readFileSync } from 'node:fs'
import { PROCESS_MEMORY_PROBE_TIMEOUT_MS } from '../constants'
import { runCommand } from './commands'

const KIBIBYTE_BYTES = 1_024

export interface MemoryReading {
  residentBytes: number
  peakResidentBytes: number | null
}

function statusKibibytes(status: string, field: string): number | null {
  const match = new RegExp(`^${field}:\\s+(\\d+) kB$`, 'm').exec(status)
  return match ? Number(match[1]) : null
}

export async function readProcessMemory(pid: number): Promise<MemoryReading> {
  const statusPath = `/proc/${pid}/status`
  if (existsSync(statusPath)) {
    const status = readFileSync(statusPath, 'utf-8')
    const resident = statusKibibytes(status, 'VmRSS')
    if (resident === null) throw new Error(`${statusPath} reports no VmRSS`)
    const peak = statusKibibytes(status, 'VmHWM')
    return {
      residentBytes: resident * KIBIBYTE_BYTES,
      peakResidentBytes: peak === null ? null : peak * KIBIBYTE_BYTES,
    }
  }
  const output = await runCommand('ps', ['-o', 'rss=', '-p', String(pid)], {
    cwd: '/',
    timeoutMs: PROCESS_MEMORY_PROBE_TIMEOUT_MS,
  })
  const resident = Number(output.trim())
  if (!Number.isSafeInteger(resident) || resident <= 0)
    throw new Error(`ps reports ${JSON.stringify(output)} for ${pid}`)
  return { residentBytes: resident * KIBIBYTE_BYTES, peakResidentBytes: null }
}

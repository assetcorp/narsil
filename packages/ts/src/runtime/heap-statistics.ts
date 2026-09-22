import { totalmem } from 'node:os'
import { getHeapStatistics } from 'node:v8'

const MEGABYTE_BYTES = 1_048_576
const IN_MEGABYTES = /^--max-old-space-size=(\d+)$/
const AS_PERCENTAGE = /^--max-old-space-size-percentage=(\d+(?:\.\d+)?)$/

export interface HeapStatistics {
  usedBytes: number
  limitBytes: number
  availableBytes: number | null
  configuredLimitBytes: number | null
}

function flagEntries(): string[] {
  const fromNodeOptions = (process.env.NODE_OPTIONS ?? '').split(/\s+/).filter(entry => entry.length > 0)
  return [...process.execArgv, ...fromNodeOptions]
}

function memoryTheHostAllows(): number {
  const constrained = process.constrainedMemory?.() ?? 0
  return constrained > 0 ? constrained : totalmem()
}

function configuredLimitBytes(): number | null {
  let megabytes: number | null = null
  let percentage: number | null = null
  for (const entry of flagEntries()) {
    const inMegabytes = IN_MEGABYTES.exec(entry)
    if (inMegabytes !== null) {
      megabytes = Number(inMegabytes[1])
      percentage = null
    }
    const asPercentage = AS_PERCENTAGE.exec(entry)
    if (asPercentage !== null) {
      percentage = Number(asPercentage[1])
      megabytes = null
    }
  }
  if (megabytes !== null && megabytes > 0) return megabytes * MEGABYTE_BYTES
  if (percentage !== null && percentage > 0 && percentage <= 100) {
    return Math.floor((memoryTheHostAllows() * percentage) / 100)
  }
  return null
}

export function readHeapStatistics(): HeapStatistics | null {
  try {
    const stats = getHeapStatistics()
    const usedBytes = stats.used_heap_size
    const limitBytes = stats.heap_size_limit
    if (!Number.isFinite(usedBytes) || !Number.isFinite(limitBytes) || limitBytes <= 0) return null
    const available = stats.total_available_size
    const availableBytes = Number.isFinite(available) && available >= 0 ? available : null
    const configured = configuredLimitBytes()
    return {
      usedBytes,
      limitBytes,
      availableBytes,
      configuredLimitBytes: configured !== null && Number.isFinite(configured) && configured > 0 ? configured : null,
    }
  } catch {
    return null
  }
}

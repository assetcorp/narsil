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

function readConfiguredLimit(): number | null {
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
  const bytes =
    megabytes !== null && megabytes > 0
      ? megabytes * MEGABYTE_BYTES
      : percentage !== null && percentage > 0 && percentage <= 100
        ? Math.floor((memoryTheHostAllows() * percentage) / 100)
        : null
  return bytes !== null && Number.isFinite(bytes) && bytes > 0 ? bytes : null
}

let configuredLimit: number | null | undefined

function configuredLimitBytes(): number | null {
  if (configuredLimit === undefined) configuredLimit = readConfiguredLimit()
  return configuredLimit
}

export function readHeapStatistics(): HeapStatistics | null {
  try {
    const stats = getHeapStatistics()
    const usedBytes = stats.used_heap_size
    const limitBytes = stats.heap_size_limit
    if (!Number.isFinite(usedBytes) || !Number.isFinite(limitBytes) || limitBytes <= 0) return null
    const available = stats.total_available_size
    const availableBytes = Number.isFinite(available) && available >= 0 ? available : null
    return { usedBytes, limitBytes, availableBytes, configuredLimitBytes: configuredLimitBytes() }
  } catch {
    return null
  }
}

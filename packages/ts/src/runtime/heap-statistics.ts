import { totalmem } from 'node:os'
import { getHeapSpaceStatistics, getHeapStatistics } from 'node:v8'

const MEGABYTE_BYTES = 1_048_576
const IN_MEGABYTES = /^--max-old-space-size=(\d+)$/
const AS_PERCENTAGE = /^--max-old-space-size-percentage=(\d+(?:\.\d+)?)$/
const SEMI_SPACE_IN_MEGABYTES = /^--max-semi-space-size=(\d+)$/
const YOUNG_GENERATION_SPACES = new Set(['new_space', 'new_large_object_space'])
const V8_YOUNG_GENERATION_BYTES_PER_SEMI_SPACE_BYTE = 3

export interface HeapStatistics {
  usedBytes: number
  limitBytes: number
  availableBytes: number | null
  configuredLimitBytes: number | null
}

export interface OldGenerationStatistics {
  usedBytes: number
  limitBytes: number
  youngUsedBytes: number
  committedBytes: number
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

function readConfiguredYoungGeneration(): number | null {
  let megabytes = 0
  for (const entry of flagEntries()) {
    const semiSpace = SEMI_SPACE_IN_MEGABYTES.exec(entry)
    if (semiSpace !== null) megabytes = Number(semiSpace[1])
  }
  if (!Number.isFinite(megabytes) || megabytes <= 0) return null
  const semiSpaceBytes = 2 ** Math.ceil(Math.log2(megabytes)) * MEGABYTE_BYTES
  return semiSpaceBytes * V8_YOUNG_GENERATION_BYTES_PER_SEMI_SPACE_BYTE
}

let configuredYoungGeneration: number | null | undefined

function configuredYoungGenerationBytes(): number | null {
  if (configuredYoungGeneration === undefined) configuredYoungGeneration = readConfiguredYoungGeneration()
  return configuredYoungGeneration
}

let heapSizeLimit: number | undefined

function heapSizeLimitBytes(): number {
  if (heapSizeLimit === undefined) heapSizeLimit = getHeapStatistics().heap_size_limit
  return heapSizeLimit
}

export function readOldGenerationStatistics(): OldGenerationStatistics | null {
  try {
    let usedBytes = 0
    let committedBytes = 0
    let youngCapacityBytes = 0
    let youngUsedBytes = 0
    for (const space of getHeapSpaceStatistics()) {
      if (YOUNG_GENERATION_SPACES.has(space.space_name)) {
        youngCapacityBytes += space.space_size
        youngUsedBytes += space.space_used_size
      } else {
        usedBytes += space.space_used_size
        committedBytes += space.space_size
      }
    }
    const limitBytes =
      configuredLimitBytes() ?? heapSizeLimitBytes() - (configuredYoungGenerationBytes() ?? youngCapacityBytes)
    if (!Number.isFinite(usedBytes) || !Number.isFinite(limitBytes) || limitBytes <= 0) return null
    return {
      usedBytes,
      limitBytes,
      youngUsedBytes: Number.isFinite(youngUsedBytes) ? youngUsedBytes : 0,
      committedBytes: Number.isFinite(committedBytes) ? committedBytes : usedBytes,
    }
  } catch {
    return null
  }
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

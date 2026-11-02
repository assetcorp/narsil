import { PROCESS_LIMIT_REFRESH_INTERVAL_MS } from './constants'
import type { ResidentMemory } from './process-limit'
import { reactNativeHost } from './react-native-host'

export type { ResidentMemory } from './process-limit'

let limitBytes = 0
let limitReadAt = Number.NEGATIVE_INFINITY

function readPhoneMemory(): ResidentMemory | null {
  const { residentBytes, availableBytes } = reactNativeHost().processMemory()
  if (!Number.isFinite(residentBytes) || residentBytes < 0) return null
  if (!Number.isFinite(availableBytes) || availableBytes < 0) return null
  return { residentBytes, limitBytes: residentBytes + availableBytes }
}

export function processLimitBytes(_residentBytes: number): number {
  const now = performance.now()
  if (now - limitReadAt >= PROCESS_LIMIT_REFRESH_INTERVAL_MS) {
    try {
      limitBytes = readPhoneMemory()?.limitBytes ?? 0
    } catch {
      limitBytes = 0
    }
    limitReadAt = now
  }
  return limitBytes
}

export function readResidentMemory(): ResidentMemory | null {
  try {
    const reading = readPhoneMemory()
    if (reading === null || reading.limitBytes <= 0) return null
    limitBytes = reading.limitBytes
    limitReadAt = performance.now()
    return reading
  } catch {
    return null
  }
}

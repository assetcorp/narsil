import { totalmem } from 'node:os'

export interface ResidentMemory {
  residentBytes: number
  limitBytes: number
}

function processLimitBytes(): number {
  const hostBytes = totalmem()
  const constrained = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0
  return Number.isFinite(constrained) && constrained > 0 && constrained < hostBytes ? constrained : hostBytes
}

export function readResidentMemory(): ResidentMemory | null {
  try {
    const residentBytes = process.memoryUsage.rss()
    const limitBytes = processLimitBytes()
    if (!Number.isFinite(residentBytes) || !Number.isFinite(limitBytes) || limitBytes <= 0) return null
    return { residentBytes, limitBytes }
  } catch {
    return null
  }
}

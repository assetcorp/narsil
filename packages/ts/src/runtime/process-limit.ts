import { freemem, totalmem } from 'node:os'
import { PROCESS_LIMIT_REFRESH_INTERVAL_MS } from './constants'

export interface ResidentMemory {
  residentBytes: number
  limitBytes: number
}

let limitBytes = 0
let limitReadAt = Number.NEGATIVE_INFINITY

function readProcessLimit(residentBytes: number): number {
  const hostBytes = totalmem()
  const constrained = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0
  if (Number.isFinite(constrained) && constrained > 0 && constrained < hostBytes) return constrained
  if (process.platform !== 'linux') return hostBytes
  const availableBytes = freemem()
  if (!Number.isFinite(availableBytes) || availableBytes < 0) return hostBytes
  return Math.min(hostBytes, residentBytes + availableBytes)
}

export function processLimitBytes(residentBytes: number): number {
  const now = performance.now()
  if (now - limitReadAt >= PROCESS_LIMIT_REFRESH_INTERVAL_MS) {
    limitBytes = readProcessLimit(residentBytes)
    limitReadAt = now
  }
  return limitBytes
}

export function readResidentMemory(): ResidentMemory | null {
  try {
    const residentBytes = process.memoryUsage.rss()
    const limitBytes = processLimitBytes(residentBytes)
    if (!Number.isFinite(residentBytes) || !Number.isFinite(limitBytes) || limitBytes <= 0) return null
    return { residentBytes, limitBytes }
  } catch {
    return null
  }
}

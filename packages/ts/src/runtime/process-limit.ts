import { closeSync, openSync, readSync } from 'node:fs'
import { freemem, totalmem } from 'node:os'
import {
  PROCESS_LIMIT_REFRESH_INTERVAL_MS,
  PROCESS_STATUS_READ_BYTES,
  PROCESS_STATUS_READ_CEILING_BYTES,
} from './constants'

export interface ProcessMemoryUse {
  processBytes: number
  limitBytes: number
}

const PROCESS_STATUS_PATH = '/proc/self/status'
const KIBIBYTE_BYTES = 1024
const ANONYMOUS_RESIDENT_FIELD = /^RssAnon:[ \t]+(\d+) kB$/m
const SHARED_RESIDENT_FIELD = /^RssShmem:[ \t]+(\d+) kB$/m

let limitBytes = 0
let limitReadAt = Number.NEGATIVE_INFINITY
let statusBytes: Buffer | null = null

function readProcessStatus(): string | null {
  let descriptor: number | null = null
  try {
    descriptor = openSync(PROCESS_STATUS_PATH, 'r')
    let buffer = statusBytes ?? Buffer.allocUnsafe(PROCESS_STATUS_READ_BYTES)
    let filled = 0
    for (;;) {
      if (filled === buffer.length) {
        if (buffer.length >= PROCESS_STATUS_READ_CEILING_BYTES) return null
        const grown = Buffer.allocUnsafe(Math.min(2 * buffer.length, PROCESS_STATUS_READ_CEILING_BYTES))
        buffer.copy(grown, 0, 0, filled)
        buffer = grown
      }
      const read = readSync(descriptor, buffer, filled, buffer.length - filled, null)
      if (read === 0) break
      filled += read
    }
    statusBytes = buffer
    return buffer.toString('latin1', 0, filled)
  } catch {
    return null
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor)
      } catch {}
    }
  }
}

function kibibyteField(status: string, field: RegExp): number | null {
  const digits = field.exec(status)?.[1]
  if (digits === undefined) return null
  const bytes = Number(digits) * KIBIBYTE_BYTES
  return Number.isSafeInteger(bytes) ? bytes : null
}

function memoryThatNoFileBacks(): number | null {
  if (process.platform !== 'linux') return null
  const status = readProcessStatus()
  if (status === null) return null
  const anonymousBytes = kibibyteField(status, ANONYMOUS_RESIDENT_FIELD)
  const sharedBytes = kibibyteField(status, SHARED_RESIDENT_FIELD)
  if (anonymousBytes === null || sharedBytes === null) return null
  const processBytes = anonymousBytes + sharedBytes
  return Number.isSafeInteger(processBytes) ? processBytes : null
}

function readProcessLimit(processBytes: number): number {
  const hostBytes = totalmem()
  const constrained = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0
  if (Number.isFinite(constrained) && constrained > 0 && constrained < hostBytes) return constrained
  if (process.platform !== 'linux') return hostBytes
  const availableBytes = freemem()
  if (!Number.isFinite(availableBytes) || availableBytes < 0) return hostBytes
  return Math.min(hostBytes, processBytes + availableBytes)
}

export function processLimitBytes(processBytes: number): number {
  const now = performance.now()
  if (now - limitReadAt >= PROCESS_LIMIT_REFRESH_INTERVAL_MS) {
    limitBytes = readProcessLimit(processBytes)
    limitReadAt = now
  }
  return limitBytes
}

export function readProcessMemoryUse(): ProcessMemoryUse | null {
  try {
    const processBytes = memoryThatNoFileBacks() ?? process.memoryUsage.rss()
    const limitBytes = processLimitBytes(processBytes)
    if (!Number.isFinite(processBytes) || !Number.isFinite(limitBytes) || limitBytes <= 0) return null
    return { processBytes, limitBytes }
  } catch {
    return null
  }
}

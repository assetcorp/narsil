import { describe, expect, it } from 'vitest'
import type { RuntimeInfo } from '../../runtime/detect'
import { detectRuntime } from '../../runtime/detect'

describe('detectRuntime', () => {
  it('returns a valid RuntimeInfo object', () => {
    const info = detectRuntime()

    expect(info).toBeDefined()
    expect(info.runtime).toBeDefined()
    expect(typeof info.cpuCount).toBe('number')
    expect(typeof info.supportsWorkerThreads).toBe('boolean')
    expect(typeof info.supportsWebWorkers).toBe('boolean')
    expect(typeof info.supportsFileSystem).toBe('boolean')
    expect(typeof info.supportsIndexedDB).toBe('boolean')
    expect(typeof info.supportsBroadcastChannel).toBe('boolean')
  })

  it('detects Node.js in a Vitest environment', () => {
    const info = detectRuntime()
    expect(info.runtime).toBe('node')
  })

  it('reports cpuCount as a positive integer', () => {
    const info = detectRuntime()
    expect(info.cpuCount).toBeGreaterThanOrEqual(1)
    expect(Number.isInteger(info.cpuCount)).toBe(true)
  })

  it('supports worker threads in Node.js', () => {
    const info = detectRuntime()
    expect(info.supportsWorkerThreads).toBe(true)
  })

  it('supports filesystem in Node.js', () => {
    const info = detectRuntime()
    expect(info.supportsFileSystem).toBe(true)
  })

  it('does not report IndexedDB support in Node.js', () => {
    const info = detectRuntime()
    expect(info.supportsIndexedDB).toBe(false)
  })

  it('reports BroadcastChannel support based on globalThis', () => {
    const info = detectRuntime()
    const expected = 'BroadcastChannel' in globalThis
    expect(info.supportsBroadcastChannel).toBe(expected)
  })

  it('returns consistent results across multiple calls', () => {
    const first = detectRuntime()
    const second = detectRuntime()
    expect(first).toEqual(second)
  })

  it('runtime value is one of the known runtimes', () => {
    const info = detectRuntime()
    const validRuntimes: RuntimeInfo['runtime'][] = ['node', 'browser', 'deno', 'bun']
    expect(validRuntimes).toContain(info.runtime)
  })
})

import { describe, expect, it } from 'vitest'
import type { RuntimeInfo } from '../../runtime/detect'
import { detectRuntime } from '../../runtime/detect'

describe('detectRuntime', () => {
  it('returns a valid RuntimeInfo object', async () => {
    const info = await detectRuntime()

    expect(info).toBeDefined()
    expect(info.runtime).toBeDefined()
    expect(typeof info.cpuCount).toBe('number')
    expect(typeof info.supportsWorkerThreads).toBe('boolean')
    expect(typeof info.supportsWebWorkers).toBe('boolean')
    expect(typeof info.supportsFileSystem).toBe('boolean')
    expect(typeof info.supportsIndexedDB).toBe('boolean')
    expect(typeof info.supportsBroadcastChannel).toBe('boolean')
  })

  it('detects Node.js in a Vitest environment', async () => {
    const info = await detectRuntime()
    expect(info.runtime).toBe('node')
  })

  it('reports cpuCount as a positive integer', async () => {
    const info = await detectRuntime()
    expect(info.cpuCount).toBeGreaterThanOrEqual(1)
    expect(Number.isInteger(info.cpuCount)).toBe(true)
  })

  it('supports worker threads in Node.js', async () => {
    const info = await detectRuntime()
    expect(info.supportsWorkerThreads).toBe(true)
  })

  it('supports filesystem in Node.js', async () => {
    const info = await detectRuntime()
    expect(info.supportsFileSystem).toBe(true)
  })

  it('does not report IndexedDB support in Node.js', async () => {
    const info = await detectRuntime()
    expect(info.supportsIndexedDB).toBe(false)
  })

  it('reports BroadcastChannel support based on globalThis', async () => {
    const info = await detectRuntime()
    const expected = 'BroadcastChannel' in globalThis
    expect(info.supportsBroadcastChannel).toBe(expected)
  })

  it('returns consistent results across multiple calls', async () => {
    const first = await detectRuntime()
    const second = await detectRuntime()
    expect(first).toEqual(second)
  })

  it('runtime value is one of the known runtimes', async () => {
    const info = await detectRuntime()
    const validRuntimes: RuntimeInfo['runtime'][] = ['node', 'browser', 'deno', 'bun']
    expect(validRuntimes).toContain(info.runtime)
  })
})

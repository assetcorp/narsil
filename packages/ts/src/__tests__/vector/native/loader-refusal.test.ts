import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorCodes } from '../../../errors'

const SETTINGS = ['NARSIL_SEARCH_BACKEND', 'NARSIL_REQUIRE_NATIVE_CORE', 'NARSIL_NATIVE_CORE_PATH'] as const

const MISSING_BINARY_PATH = '/narsil-core-that-no-machine-holds.node'

describe('loading the native search core', () => {
  const before = new Map<string, string | undefined>()

  beforeEach(() => {
    for (const name of SETTINGS) {
      before.set(name, process.env[name])
      delete process.env[name]
    }
    vi.resetModules()
  })

  afterEach(() => {
    for (const name of SETTINGS) {
      const value = before.get(name)
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    vi.resetModules()
  })

  it('refuses every call while NARSIL_REQUIRE_NATIVE_CORE is 1 and no core loads', async () => {
    process.env.NARSIL_REQUIRE_NATIVE_CORE = '1'
    process.env.NARSIL_NATIVE_CORE_PATH = MISSING_BINARY_PATH
    const { loadNativeCore } = await import('../../../vector/native/loader')

    for (let attempt = 0; attempt < 3; attempt++) {
      expect(() => loadNativeCore()).toThrowError(expect.objectContaining({ code: ErrorCodes.CONFIG_INVALID }))
    }
  })

  it('warns once on the thread that falls back to WebAssembly', async () => {
    process.env.NARSIL_NATIVE_CORE_PATH = MISSING_BINARY_PATH
    const warnings: unknown[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args[0])
    })
    const { loadNativeCore } = await import('../../../vector/native/loader')

    expect(loadNativeCore()).toBeNull()
    expect(loadNativeCore()).toBeNull()

    warn.mockRestore()
    expect(warnings).toHaveLength(1)
    expect(String(warnings[0])).toContain('on this thread')
  })

  it('refuses a search backend it does not define', async () => {
    process.env.NARSIL_SEARCH_BACKEND = 'turbo'
    const { loadNativeCore } = await import('../../../vector/native/loader')

    expect(() => loadNativeCore()).toThrowError(expect.objectContaining({ code: ErrorCodes.CONFIG_INVALID }))
  })

  it('reads the backend name whatever its case', async () => {
    process.env.NARSIL_SEARCH_BACKEND = 'WASM'
    const { loadNativeCore } = await import('../../../vector/native/loader')

    expect(loadNativeCore()).toBeNull()
  })
})

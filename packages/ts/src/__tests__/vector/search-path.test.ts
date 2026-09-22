import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const SETTINGS = ['NARSIL_SEARCH_BACKEND', 'NARSIL_REQUIRE_NATIVE_CORE'] as const

describe('the path through which a process searches vector graphs', () => {
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

  it('is WebAssembly where NARSIL_SEARCH_BACKEND asks for it, whatever the machine holds', async () => {
    process.env.NARSIL_SEARCH_BACKEND = 'wasm'
    const { vectorSearchPath } = await import('../../vector/native/search-path')

    expect(vectorSearchPath()).toBe('wasm')
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('the path through which a process searches vector graphs', () => {
  let backendBefore: string | undefined

  beforeEach(() => {
    backendBefore = process.env.NARSIL_SEARCH_BACKEND
    vi.resetModules()
  })

  afterEach(() => {
    if (backendBefore === undefined) delete process.env.NARSIL_SEARCH_BACKEND
    else process.env.NARSIL_SEARCH_BACKEND = backendBefore
    vi.resetModules()
  })

  it('is WebAssembly where NARSIL_SEARCH_BACKEND asks for it, whatever the machine holds', async () => {
    process.env.NARSIL_SEARCH_BACKEND = 'wasm'
    const { vectorSearchPath } = await import('../../../vector/native/search-path')

    expect(vectorSearchPath()).toBe('wasm')
  })
})

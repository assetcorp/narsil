import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchEngineStatus } from '../src/lib/engine-status'

const originalFetch = globalThis.fetch

function stubFetch(response: Response): void {
  globalThis.fetch = vi.fn(async () => response) as unknown as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('fetchEngineStatus', () => {
  it('passes a starting status through', async () => {
    stubFetch(new Response(JSON.stringify({ phase: 'starting' }), { status: 200 }))
    expect(await fetchEngineStatus()).toEqual({ phase: 'starting', error: undefined })
  })

  it('passes an error status through with its message', async () => {
    stubFetch(new Response(JSON.stringify({ phase: 'error', error: 'port in use' }), { status: 200 }))
    expect(await fetchEngineStatus()).toEqual({ phase: 'error', error: 'port in use' })
  })

  it('treats a ready status as ready', async () => {
    stubFetch(new Response(JSON.stringify({ phase: 'ready' }), { status: 200 }))
    expect(await fetchEngineStatus()).toEqual({ phase: 'ready' })
  })

  it('treats a missing status route as ready', async () => {
    stubFetch(new Response('Not found', { status: 404 }))
    expect(await fetchEngineStatus()).toEqual({ phase: 'ready' })
  })

  it('treats an unrecognised phase as ready', async () => {
    stubFetch(new Response(JSON.stringify({ phase: 'warming' }), { status: 200 }))
    expect(await fetchEngineStatus()).toEqual({ phase: 'ready' })
  })
})

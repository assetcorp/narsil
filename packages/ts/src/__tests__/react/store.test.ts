import { describe, expect, it } from 'vitest'
import { NarsilError } from '../../errors'
import { createResourceStore, type ResourceLoader } from '../../react/store'

const KEEP_ALIVE_MS = 10

interface Held {
  signal: AbortSignal
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

function heldLoader(): { loader: ResourceLoader; calls: Held[] } {
  const calls: Held[] = []
  const loader: ResourceLoader = signal =>
    new Promise((resolve, reject) => {
      calls.push({ signal, resolve, reject })
    })
  return { loader, calls }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function drain(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('the react resource store', () => {
  it('sends one request for two readers of the same key, and tells both about the answer', async () => {
    const store = createResourceStore(KEEP_ALIVE_MS)
    const { loader, calls } = heldLoader()
    let first = 0
    let second = 0

    store.subscribe('k', loader, () => first++)
    store.subscribe('k', loader, () => second++)
    expect(calls).toHaveLength(1)

    calls[0].resolve(['movies'])
    await drain()
    expect(first).toBeGreaterThan(0)
    expect(second).toBeGreaterThan(0)
    expect(store.snapshot('k').data).toEqual(['movies'])
    expect(store.snapshot('k').isLoading).toBe(false)
  })

  it('hands back the same snapshot until the answer moves', async () => {
    const store = createResourceStore(KEEP_ALIVE_MS)
    const { loader, calls } = heldLoader()
    store.subscribe('k', loader, () => undefined)

    expect(store.snapshot('k')).toBe(store.snapshot('k'))
    calls[0].resolve(1)
    await drain()
    expect(store.snapshot('k')).toBe(store.snapshot('k'))
  })

  it('keeps the newest answer when an older request answers late', async () => {
    const store = createResourceStore(KEEP_ALIVE_MS)
    const { loader, calls } = heldLoader()
    store.subscribe('k', loader, () => undefined)

    calls[0].resolve('first')
    await drain()
    store.refresh('k')
    expect(calls).toHaveLength(2)

    calls[1].resolve('second')
    await drain()
    calls[0].resolve('stale')
    await drain()
    expect(store.snapshot('k').data).toBe('second')
  })

  it('ignores a refresh while a request is already in flight', () => {
    const store = createResourceStore(KEEP_ALIVE_MS)
    const { loader, calls } = heldLoader()
    store.subscribe('k', loader, () => undefined)

    store.refresh('k')
    store.refresh('k')
    expect(calls).toHaveLength(1)
  })

  it('keeps the answer while one of two readers leaves', async () => {
    const store = createResourceStore(KEEP_ALIVE_MS)
    const { loader, calls } = heldLoader()
    const leave = store.subscribe('k', loader, () => undefined)
    store.subscribe('k', loader, () => undefined)

    calls[0].resolve('answer')
    await drain()
    leave()
    await sleep(KEEP_ALIVE_MS * 3)
    expect(store.snapshot('k').data).toBe('answer')
    expect(calls[0].signal.aborted).toBe(false)
  })

  it('gives the answer back to a reader that returns within the keep-alive, and asks for nothing', async () => {
    const store = createResourceStore(KEEP_ALIVE_MS)
    const { loader, calls } = heldLoader()
    const leave = store.subscribe('k', loader, () => undefined)
    calls[0].resolve('answer')
    await drain()

    leave()
    store.subscribe('k', loader, () => undefined)
    await sleep(KEEP_ALIVE_MS * 3)
    expect(store.snapshot('k').data).toBe('answer')
    expect(calls).toHaveLength(1)
  })

  it('stops the request and forgets the answer once the keep-alive passes', async () => {
    const store = createResourceStore(KEEP_ALIVE_MS)
    const { loader, calls } = heldLoader()
    const leave = store.subscribe('k', loader, () => undefined)

    leave()
    expect(calls[0].signal.aborted).toBe(false)
    await sleep(KEEP_ALIVE_MS * 3)
    expect(calls[0].signal.aborted).toBe(true)
    expect(store.snapshot('k').isLoading).toBe(true)
    expect(store.snapshot('k').data).toBeUndefined()
  })

  it('reports a failure and keeps whatever it already showed', async () => {
    const store = createResourceStore(KEEP_ALIVE_MS)
    const { loader, calls } = heldLoader()
    store.subscribe('k', loader, () => undefined)

    calls[0].resolve('answer')
    await drain()
    store.refresh('k')
    calls[1].reject(new NarsilError('INDEX_NOT_FOUND', 'gone'))
    await drain()

    expect(store.snapshot('k').data).toBe('answer')
    expect(store.snapshot('k').error?.code).toBe('INDEX_NOT_FOUND')
    expect(store.snapshot('k').isFetching).toBe(false)
  })

  it('wraps a failure that is not a NarsilError, so a hook always reads one', async () => {
    const store = createResourceStore(KEEP_ALIVE_MS)
    const { loader, calls } = heldLoader()
    store.subscribe('k', loader, () => undefined)

    calls[0].reject(new TypeError('fetch is not a function'))
    await drain()
    expect(store.snapshot('k').error).toBeInstanceOf(NarsilError)
    expect(store.snapshot('k').error?.message).toContain('fetch is not a function')
  })

  it('tries again for a reader that arrives after a failure', async () => {
    const store = createResourceStore(KEEP_ALIVE_MS)
    const { loader, calls } = heldLoader()
    store.subscribe('k', loader, () => undefined)

    calls[0].reject(new NarsilError('INDEX_NOT_FOUND', 'gone'))
    await drain()
    expect(calls).toHaveLength(1)

    store.subscribe('k', loader, () => undefined)
    expect(calls).toHaveLength(2)
  })

  it('says nothing to a reader that has left', async () => {
    const store = createResourceStore(KEEP_ALIVE_MS)
    const { loader, calls } = heldLoader()
    let told = 0
    const leave = store.subscribe('k', loader, () => told++)
    const settled = told

    leave()
    calls[0].resolve('answer')
    await drain()
    expect(told).toBe(settled)
  })

  it('stops everything in flight when the provider unmounts', async () => {
    const store = createResourceStore(KEEP_ALIVE_MS)
    const { loader, calls } = heldLoader()
    store.subscribe('one', loader, () => undefined)
    store.subscribe('two', loader, () => undefined)

    store.dispose()
    expect(calls.map(call => call.signal.aborted)).toEqual([true, true])
    expect(store.snapshot('one').data).toBeUndefined()
  })
})

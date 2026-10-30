// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { createNarsilClient } from '../../client'
import { ErrorCodes } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import {
  NarsilProvider,
  useDocument,
  useDocuments,
  useImport,
  useIndexes,
  useNarsilClient,
  usePreflight,
  useQuery,
  useStats,
  useSuggest,
  useTask,
  useTasks,
} from '../../react'
import type { QueryParams } from '../../types/search'
import { startTestServer, type TestServer } from '../server/helpers'
import { interact, renderBare, renderHookUnder, settle, sleep, waitFor } from './helpers'

const PRODUCTS = {
  schema: { title: 'string', category: 'enum', price: 'number', shade: 'vector[2]' },
  language: 'english',
} as const

const CATALOGUE = [
  { id: 'p1', title: 'Desk Lamp', category: 'home', price: 25, shade: [1, 0] },
  { id: 'p2', title: 'Floor Lamp', category: 'home', price: 75, shade: [0.5, 0.25] },
  { id: 'p3', title: 'Lamp Shade', category: 'home', price: 15, shade: [0, 1] },
  { id: 'p4', title: 'Wireless Headphones', category: 'audio', price: 99, shade: [0.75, 0.5] },
]

const LAMPS: QueryParams = { term: 'lamp', facets: { category: {} }, sort: { price: 'asc' } }

function useEveryRead() {
  return {
    query: useQuery('products', LAMPS),
    preflight: usePreflight('products', LAMPS),
    suggest: useSuggest('products', { prefix: 'la' }),
    document: useDocument('products', 'p2'),
    missing: useDocument('products', 'absent'),
    documents: useDocuments('products', { limit: 3 }),
    indexes: useIndexes(),
    stats: useStats('products'),
    unknown: useStats('absent'),
  }
}

type EveryRead = ReturnType<typeof useEveryRead>

function settled(reads: EveryRead): boolean {
  return Object.values(reads).every(read => !read.isLoading && !read.isFetching)
}

function withoutTiming(reads: EveryRead): Record<string, unknown> {
  const shown: Record<string, unknown> = {}
  for (const [name, read] of Object.entries(reads)) {
    const data = read.data as Record<string, unknown> | undefined
    const timed = data !== undefined && !Array.isArray(data) && 'elapsed' in data
    shown[name] = { data: timed ? { ...data, elapsed: 0 } : data, error: read.error?.code }
  }
  return shown
}

async function lampEngine(): Promise<Narsil> {
  const engine = await createNarsil({ workers: { enabled: false } })
  await engine.createIndex('products', PRODUCTS)
  await engine.insertBatch('products', CATALOGUE)
  return engine
}

describe('react hooks over an in-browser engine', () => {
  let server: TestServer | null = null
  let engine: Narsil | null = null

  afterEach(async () => {
    await server?.stop()
    await engine?.shutdown()
    server = null
    engine = null
  })

  it('returns what a client of a server holding the same index returns, from every read hook', async () => {
    server = await startTestServer(undefined, { workers: { enabled: false } }, async held => {
      await held.createIndex('products', PRODUCTS)
      await held.insertBatch('products', CATALOGUE)
    })
    const client = createNarsilClient({ url: server.base })

    const overHttp = await renderHookUnder(useEveryRead, { client })
    const inBrowser = await renderHookUnder(useEveryRead, { engine: server.engine })
    await waitFor(() => settled(overHttp.current()) && settled(inBrowser.current()))
    await interact(() => {
      overHttp.current().stats.refresh()
      inBrowser.current().stats.refresh()
    })
    await waitFor(() => settled(overHttp.current()) && settled(inBrowser.current()))

    const expected = withoutTiming(overHttp.current())
    expect(expected.query).toMatchObject({ data: { count: 3 } })
    expect(expected.document).toEqual({ data: { ...CATALOGUE[1] }, error: undefined })
    expect(Array.isArray(inBrowser.current().document.data?.shade)).toBe(true)
    expect(expected.missing).toEqual({ data: undefined, error: undefined })
    expect(expected.unknown).toEqual({ data: undefined, error: ErrorCodes.INDEX_NOT_FOUND })
    expect(withoutTiming(inBrowser.current())).toEqual(expected)

    await overHttp.unmount()
    await inBrowser.unmount()
  })

  it('refuses the task and import hooks, and the client, because only a server runs them', async () => {
    engine = await lampEngine()
    const held = engine
    const hooks: Array<() => unknown> = [
      () => useTask('t1'),
      () => useTasks(),
      () => useImport('products'),
      () => useNarsilClient(),
    ]
    for (const useHook of hooks) {
      function Probe(): ReactNode {
        useHook()
        return null
      }
      await expect(
        renderBare(createElement(NarsilProvider, { engine: held }, createElement(Probe))),
      ).rejects.toMatchObject({ code: ErrorCodes.CONFIG_INVALID })
    }
  })

  it('discards an answer whose search started before the latest write', async () => {
    engine = await lampEngine()
    const held = engine
    const original = held.query.bind(held)
    let gate: Promise<void> | null = null
    let staleAnswer: unknown = null
    Object.assign(held, {
      query: async (indexName: string, params: QueryParams) => {
        const answer = await original(indexName, params)
        if (gate === null) return answer
        staleAnswer = answer
        await gate
        return answer
      },
    })

    const view = await renderHookUnder(() => useQuery('products', LAMPS), { engine: held })
    await waitFor(() => view.current().data !== undefined)
    const before = view.current().data

    let release: () => void = () => undefined
    gate = new Promise(resolve => {
      release = resolve
    })
    await interact(() => view.current().refresh())
    await waitFor(() => staleAnswer !== null)
    gate = null

    await held.insert('products', { title: 'Reading Lamp', category: 'home', price: 35 }, 'p5')
    await sleep(5)
    release()
    await settle(20)
    expect(view.current().data).toBe(before)

    await waitFor(() => view.current().data?.count === 4)
    for (let render = 0; render < view.renders(); render++) {
      expect(view.at(render).data).not.toBe(staleAnswer)
    }
    await view.unmount()
  })
})

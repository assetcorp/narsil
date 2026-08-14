// @vitest-environment jsdom

import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { NarsilProvider, useIndexes, useTask } from '../../react'
import type { IndexInfo } from '../../types/results'
import { clientFor, interact, json, renderHook, route, setPageHidden, settle, stubServer, waitFor } from './helpers'

interface Held {
  answer: (indexes: IndexInfo[]) => void
}

function heldServer(): { server: ReturnType<typeof stubServer>; waiting: Held[] } {
  const waiting: Held[] = []
  const server = stubServer([
    route(
      '/indexes',
      () =>
        new Promise<{ status: number; body: unknown }>(resolve => {
          waiting.push({ answer: indexes => resolve({ status: 200, body: { indexes } }) })
        }),
    ),
  ])
  return { server, waiting }
}

function named(name: string): IndexInfo[] {
  return [{ name, documentCount: 1, language: 'english' } as IndexInfo]
}

afterEach(() => {
  setPageHidden(false)
})

describe('react hook lifecycle', () => {
  it('never lets a late answer replace a newer one', async () => {
    const { server, waiting } = heldServer()
    let generation = 0
    const view = await renderHook(
      () => useIndexes({ headers: { 'x-generation': String(generation) } }),
      clientFor(server),
    )
    await waitFor(() => waiting.length === 1)

    generation = 1
    await view.rerender()
    await waitFor(() => waiting.length === 2)

    waiting[1].answer(named('newest'))
    await waitFor(() => view.current().data !== undefined)
    expect(view.current().data?.[0].name).toBe('newest')

    waiting[0].answer(named('stale'))
    await settle(20)
    expect(view.current().data?.[0].name).toBe('newest')
    await view.unmount()
  })

  it('sends one request under a development double render', async () => {
    const server = stubServer([route('/indexes', () => json({ indexes: named('movies') }))])
    const view = await renderHook(() => useIndexes(), clientFor(server), { strict: true })

    await waitFor(() => view.current().data !== undefined)
    await settle(20)
    expect(server.countOf('/indexes')).toBe(1)
    await view.unmount()
  })

  it('stops rendering once the answer has arrived', async () => {
    const server = stubServer([route('/indexes', () => json({ indexes: named('movies') }))])
    const view = await renderHook(() => useIndexes(), clientFor(server))

    await waitFor(() => view.current().data !== undefined)
    const rendered = view.renders()
    await settle(30)
    expect(view.renders()).toBe(rendered)
    await view.unmount()
  })

  it('pauses polling while the page is hidden, and catches up when it comes back', async () => {
    const server = stubServer([
      route('/tasks/', () =>
        json({ id: 't1', type: 'import', indexName: 'movies', status: 'running', owner: 's', createdAt: 1 }),
      ),
    ])
    const view = await renderHook(() => useTask('t1', { pollIntervalMs: 5 }), clientFor(server))
    await waitFor(() => server.countOf('/tasks/') >= 2)

    await interact(() => setPageHidden(true))
    await settle(10)
    const asked = server.countOf('/tasks/')
    await settle(40)
    expect(server.countOf('/tasks/')).toBe(asked)

    await interact(() => setPageHidden(false))
    await waitFor(() => server.countOf('/tasks/') > asked)
    await view.unmount()
  })

  it('renders on a server as loading, and asks for nothing there', async () => {
    const server = stubServer([route('/indexes', () => json({ indexes: [] }))])

    function Probe(): string {
      const state = useIndexes()
      return `${String(state.isLoading)}:${String(state.data === undefined)}`
    }

    const markup = renderToString(createElement(NarsilProvider, { client: clientFor(server) }, createElement(Probe)))
    expect(markup).toContain('true:true')
    expect(server.calls).toHaveLength(0)
  })
})

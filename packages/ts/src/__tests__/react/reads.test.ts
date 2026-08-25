// @vitest-environment jsdom

import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { NarsilError } from '../../errors'
import { useDocument, useNarsilClient, useQuery } from '../../react'
import type { QueryResult } from '../../types/results'
import { clientFor, interact, json, renderBare, renderHook, route, settle, stubServer, waitFor } from './helpers'

function hits(...titles: string[]): QueryResult {
  return {
    hits: titles.map((title, at) => ({ id: `m${at}`, score: 1, document: { title } })),
    count: titles.length,
    elapsed: 1,
    coverage: { totalPartitions: 1, queriedPartitions: 1, timedOutPartitions: 0, failedPartitions: 0 },
  }
}

function searchServer(answer: QueryResult): ReturnType<typeof stubServer> {
  return stubServer([route('/search', () => json(answer), 'POST')])
}

describe('react read hooks', () => {
  it('runs the search once and reports the hits', async () => {
    const server = searchServer(hits('The Matrix'))
    const view = await renderHook(() => useQuery('movies', { term: 'matrix' }), clientFor(server))

    expect(view.at(0).isLoading).toBe(true)
    expect(view.at(0).data).toBeUndefined()
    await waitFor(() => view.current().data !== undefined)

    expect(view.current().data?.hits).toHaveLength(1)
    expect(view.current().isLoading).toBe(false)
    expect(view.current().isFetching).toBe(false)
    expect(server.countOf('/search')).toBe(1)
    await view.unmount()
  })

  it('sends one request for two components asking the same thing', async () => {
    const server = searchServer(hits('The Matrix'))
    const view = await renderHook(() => {
      const first = useQuery('movies', { term: 'matrix' })
      const second = useQuery('movies', { term: 'matrix' })
      return { first, second }
    }, clientFor(server))

    await waitFor(() => view.current().first.data !== undefined)
    expect(view.current().second.data).toBe(view.current().first.data)
    expect(server.countOf('/search')).toBe(1)
    await view.unmount()
  })

  it('searches again whenever the parameters change, and never for the same ones twice', async () => {
    const server = stubServer([route('/search', () => json(hits('one')), 'POST')])
    let term = 'matrix'
    const view = await renderHook(() => useQuery('movies', { term }), clientFor(server))
    await waitFor(() => view.current().data !== undefined)

    await view.rerender()
    expect(server.countOf('/search')).toBe(1)

    term = 'inception'
    await view.rerender()
    await waitFor(() => server.countOf('/search') === 2)
    await view.unmount()
  })

  it('sends nothing while the hook is switched off', async () => {
    const server = searchServer(hits('The Matrix'))
    const view = await renderHook(() => useQuery('movies', { term: '' }, { enabled: false }), clientFor(server))

    await settle(20)
    expect(server.calls).toHaveLength(0)
    expect(view.current().isLoading).toBe(false)
    expect(view.current().data).toBeUndefined()
    await view.unmount()
  })

  it('holds the last hits on screen while the next answer loads', async () => {
    const held: { release: (() => void) | null } = { release: null }
    let searches = 0
    const server = stubServer([
      route(
        '/search',
        () => {
          searches++
          if (searches === 1) return json(hits('first'))
          return new Promise<{ status: number; body: unknown }>(resolve => {
            held.release = () => resolve({ status: 200, body: hits('second') })
          })
        },
        'POST',
      ),
    ])

    let term = 'first'
    const view = await renderHook(() => useQuery('movies', { term }, { keepPreviousData: true }), clientFor(server))
    await waitFor(() => view.current().data !== undefined)
    const first = view.current().data

    term = 'second'
    await view.rerender()
    await waitFor(() => server.countOf('/search') === 2)
    expect(view.current().data).toBe(first)
    expect(view.current().isFetching).toBe(true)
    expect(view.current().isLoading).toBe(false)

    await waitFor(() => held.release !== null)
    held.release?.()
    await waitFor(() => view.current().data !== first)
    expect(view.current().data?.hits[0].document.title).toBe('second')
    await view.unmount()
  })

  it('reports the failure the server sent, and reads again on demand', async () => {
    let failing = true
    const server = stubServer([
      route(
        '/search',
        () =>
          failing
            ? json({ error: { code: 'SEARCH_INVALID_FIELD', message: 'no such field' } }, 400)
            : json(hits('recovered')),
        'POST',
      ),
    ])
    const view = await renderHook(() => useQuery('movies', { term: 'matrix' }), clientFor(server))

    await waitFor(() => view.current().error !== undefined)
    const failure = view.current().error
    expect(failure).toBeInstanceOf(NarsilError)
    expect(failure?.code).toBe('SEARCH_INVALID_FIELD')
    expect(failure?.details?.status).toBe(400)
    expect(view.current().isLoading).toBe(false)

    failing = false
    await interact(() => view.current().refresh())
    await waitFor(() => view.current().data !== undefined)
    expect(view.current().error).toBeUndefined()
    await view.unmount()
  })

  it('tells an unknown document from one still on its way, and waits for an id', async () => {
    const server = stubServer([
      route('/documents/', () => json({ error: { code: 'DOC_NOT_FOUND', message: 'gone' } }, 404)),
    ])
    let docId: string | null = null
    const view = await renderHook(() => useDocument('movies', docId), clientFor(server))

    await settle(20)
    expect(server.calls).toHaveLength(0)
    expect(view.current().isLoading).toBe(false)

    docId = 'tt/0133093'
    await view.rerender()
    await waitFor(() => server.calls.length === 1 && view.current().isLoading === false)
    expect(view.current().data).toBeUndefined()
    expect(view.current().error).toBeUndefined()
    expect(server.calls[0].url).toContain('tt%2F0133093')
    await view.unmount()
  })

  it('shows no stale document for an id the index does not hold, even while keeping the last answer', async () => {
    const server = stubServer([
      route('/documents/known', () => json({ document: { id: 'known', title: 'The Matrix' } })),
      route('/documents/', () => json({ error: { code: 'DOC_NOT_FOUND', message: 'gone' } }, 404)),
    ])
    let docId = 'known'
    const view = await renderHook(() => useDocument('movies', docId, { keepPreviousData: true }), clientFor(server))
    await waitFor(() => view.current().data !== undefined)

    docId = 'missing'
    await view.rerender()
    await waitFor(() => server.calls.length === 2 && view.current().isFetching === false)
    expect(view.current().data).toBeUndefined()
    expect(view.current().error).toBeUndefined()
    await view.unmount()
  })

  it('refuses to run outside a provider', async () => {
    function Orphan(): null {
      useNarsilClient()
      return null
    }
    await expect(renderBare(createElement(Orphan))).rejects.toThrow(NarsilError)
  })
})

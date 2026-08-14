// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { NarsilError } from '../../errors'
import { useImport, useTask } from '../../react'
import type { TaskRecord, TaskStatus } from '../../server/types'
import { clientFor, interact, json, renderHook, route, settle, stubServer, waitFor } from './helpers'

const FAST_POLL_MS = 5

function record(status: TaskStatus, indexed = 0): TaskRecord {
  return {
    id: 't1',
    type: 'import',
    indexName: 'movies',
    status,
    owner: 'server-1',
    createdAt: 1,
    progress: { indexed, failed: 0, bytesProcessed: indexed * 10, bytesTotal: 100 },
    ...(status === 'succeeded' ? { result: { indexed, failed: 0, errors: [], errorsTruncated: false } } : {}),
  }
}

function taskServer(statuses: TaskRecord[]): ReturnType<typeof stubServer> {
  let at = 0
  return stubServer([
    route('/tasks/', () => {
      const next = statuses[Math.min(at, statuses.length - 1)]
      at++
      return json(next)
    }),
  ])
}

describe('useTask', () => {
  it('polls a running task and stops once it finishes', async () => {
    const server = taskServer([record('running', 1), record('running', 2), record('succeeded', 3)])
    const view = await renderHook(() => useTask('t1', { pollIntervalMs: FAST_POLL_MS }), clientFor(server))

    await waitFor(() => view.current().data?.status === 'succeeded')
    const asked = server.countOf('/tasks/')
    await settle(50)
    expect(server.countOf('/tasks/')).toBe(asked)
    expect(view.current().data?.progress?.indexed).toBe(3)
    await view.unmount()
  })

  it('asks for nothing without an id', async () => {
    const server = taskServer([record('running')])
    const view = await renderHook(() => useTask(null, { pollIntervalMs: FAST_POLL_MS }), clientFor(server))

    await settle(30)
    expect(server.calls).toHaveLength(0)
    expect(view.current().isLoading).toBe(false)
    await view.unmount()
  })

  it('stops asking once the server no longer holds the record', async () => {
    const server = stubServer([
      route('/tasks/', () => json({ error: { code: 'TASK_NOT_FOUND', message: 'gone' } }, 404)),
    ])
    const view = await renderHook(() => useTask('t1', { pollIntervalMs: FAST_POLL_MS }), clientFor(server))

    await waitFor(() => view.current().data === null)
    await settle(40)
    expect(server.countOf('/tasks/')).toBe(1)
    await view.unmount()
  })

  it('leaves five seconds between attempts while the server is failing', async () => {
    const server = stubServer([
      route('/tasks/', () => json({ error: { code: 'INTERNAL_ERROR', message: 'down' } }, 500)),
    ])
    const view = await renderHook(() => useTask('t1', { pollIntervalMs: FAST_POLL_MS }), clientFor(server))

    await waitFor(() => view.current().error !== undefined)
    const asked = server.countOf('/tasks/')
    await settle(60)
    expect(server.countOf('/tasks/')).toBe(asked)
    await view.unmount()
  })

  it('stops polling when the component unmounts', async () => {
    const server = taskServer([record('running')])
    const view = await renderHook(() => useTask('t1', { pollIntervalMs: FAST_POLL_MS }), clientFor(server))

    await waitFor(() => server.countOf('/tasks/') >= 2)
    await view.unmount()
    const asked = server.countOf('/tasks/')
    await settle(40)
    expect(server.countOf('/tasks/')).toBe(asked)
  })
})

describe('useImport', () => {
  function importServer(statuses: TaskRecord[]): ReturnType<typeof stubServer> {
    let at = 0
    return stubServer([
      route('_import', () => json(record('running')), 'POST'),
      route('/tasks/', () => {
        const next = statuses[Math.min(at, statuses.length - 1)]
        at++
        return json(next)
      }),
    ])
  }

  it('sends the corpus, follows the load, and reports what the server accepted', async () => {
    const server = importServer([record('running', 1), record('succeeded', 2)])
    const settledOn: TaskRecord[] = []
    const view = await renderHook(
      () =>
        useImport('movies', {
          pollIntervalMs: FAST_POLL_MS,
          onSettled: finished => settledOn.push(finished),
        }),
      clientFor(server),
    )

    expect(view.current().isImporting).toBe(false)
    await interact(() => {
      void view.current().start([{ id: 'm1', title: 'The Matrix' }])
    })

    await waitFor(() => view.current().task !== undefined)
    expect(view.current().isImporting).toBe(true)
    expect(server.calls[0].url).toContain('async=true')
    expect(server.calls[0].body).toBe('{"id":"m1","title":"The Matrix"}')

    await waitFor(() => view.current().task?.status === 'succeeded')
    expect(view.current().isImporting).toBe(false)
    expect(view.current().result?.indexed).toBe(2)
    expect(view.current().progress?.bytesTotal).toBe(100)

    await settle(40)
    expect(settledOn).toHaveLength(1)
    await view.unmount()
  })

  it('reports a corpus the server refused, and throws it to the caller', async () => {
    const server = stubServer([
      route('_import', () => json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'too big' } }, 413), 'POST'),
    ])
    const view = await renderHook(() => useImport('movies'), clientFor(server))

    let thrown: unknown = null
    await interact(() => {
      void view
        .current()
        .start('{}')
        .catch((err: unknown) => {
          thrown = err
        })
    })

    await waitFor(() => view.current().error !== undefined)
    expect(view.current().error?.code).toBe('PAYLOAD_TOO_LARGE')
    expect(view.current().isImporting).toBe(false)
    expect(thrown).toBeInstanceOf(NarsilError)
    await view.unmount()
  })

  it('asks a running load to stop, and reads the record it stopped on', async () => {
    const server = stubServer([
      route('_import', () => json(record('running')), 'POST'),
      route('_cancel', () => json(record('cancelled', 1)), 'POST'),
      route('/tasks/', () => json(record('running')), 'GET'),
    ])
    const view = await renderHook(() => useImport('movies', { pollIntervalMs: FAST_POLL_MS }), clientFor(server))

    await interact(() => {
      void view.current().start([{ id: 'm1' }])
    })
    await waitFor(() => view.current().task !== undefined)

    await interact(() => {
      view.current().cancel()
    })
    await waitFor(() => view.current().task?.status === 'cancelled')
    expect(view.current().isImporting).toBe(false)

    const asked = server.countOf('/tasks/')
    await settle(40)
    expect(server.countOf('/tasks/')).toBe(asked)
    await view.unmount()
  })

  it('clears the record so that another load can start', async () => {
    const server = importServer([record('succeeded', 1)])
    const view = await renderHook(() => useImport('movies', { pollIntervalMs: FAST_POLL_MS }), clientFor(server))

    await interact(() => {
      void view.current().start([{ id: 'm1' }])
    })
    await waitFor(() => view.current().task !== undefined)

    await interact(() => {
      view.current().reset()
    })
    expect(view.current().task).toBeUndefined()
    expect(view.current().error).toBeUndefined()
    expect(view.current().isImporting).toBe(false)
    await view.unmount()
  })
})

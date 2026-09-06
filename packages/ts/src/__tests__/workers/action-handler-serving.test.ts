import { MessageChannel } from 'node:worker_threads'
import { describe, expect, it, vi } from 'vitest'
import type { RequestThreadSettings } from '../../server/request-threads/messages'
import { closeRequestThread, serveRequests } from '../../server/request-threads/thread'
import { createActionHandler } from '../../workers/action-handler'
import type { DirectExecutorExtensions } from '../../workers/direct-executor'
import type { Executor } from '../../workers/executor'
import type { WorkerAction, WorkerResponse } from '../../workers/protocol'

vi.mock('../../server/request-threads/thread', () => ({
  serveRequests: vi.fn(),
  closeRequestThread: vi.fn(),
}))

function createCopyHoldingExecutor(): Executor & Partial<DirectExecutorExtensions> {
  return {
    async execute<T>(): Promise<T> {
      return undefined as T
    },
    async shutdown(): Promise<void> {},
    queryContextOf: () => undefined,
  }
}

function settings(): RequestThreadSettings {
  const { port1 } = new MessageChannel()
  return {
    port: port1,
    gate: new SharedArrayBuffer(64),
    gateSlot: 1,
    maxConcurrentRequests: 0,
    touchIntervalMs: 1000,
    cors: null,
    limits: {
      maxBodyBytes: 1024,
      maxImportBytes: 1024,
      maxLineBytes: 1024,
      importBatchSize: 10,
      maxConcurrentRequests: 0,
      maxResultWindow: 100,
      maxFetchDocuments: 100,
      maxImportErrors: 10,
      maxTaskPageSize: 10,
      maxConcurrentTasks: 1,
    },
    build: { version: null, gitSha: null, dirty: false },
    authorizes: false,
    searchHooks: false,
  }
}

function collectResponses(): { posts: WorkerResponse[]; post: (msg: WorkerResponse) => void } {
  const posts: WorkerResponse[] = []
  return {
    posts,
    post: (msg: WorkerResponse) => {
      posts.push(msg)
    },
  }
}

describe('a shutdown that arrives while the worker is still starting to serve requests', () => {
  it('closes the request thread once serving has started', async () => {
    let finishServing: () => void = () => undefined
    vi.mocked(serveRequests).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishServing = () => resolve({ descriptor: 'child-app' })
        }),
    )
    vi.mocked(closeRequestThread).mockClear()
    const handler = createActionHandler(createCopyHoldingExecutor())
    const { posts, post } = collectResponses()
    const serve: WorkerAction = { type: 'serveRequests', requestId: 'serve-1', settings: settings() }

    const serving = handler(serve, post)
    const shutdown = handler({ type: 'shutdown', requestId: 'shutdown-1' }, post)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(posts).toEqual([])

    finishServing()
    await Promise.all([serving, shutdown])

    expect(vi.mocked(closeRequestThread)).toHaveBeenCalledTimes(1)
    expect(posts.map(response => response.requestId)).toEqual(['serve-1', 'shutdown-1'])
  })

  it('skips the close when serving failed to start', async () => {
    vi.mocked(serveRequests).mockRejectedValueOnce(new Error('no child apps'))
    vi.mocked(closeRequestThread).mockClear()
    const handler = createActionHandler(createCopyHoldingExecutor())
    const { posts, post } = collectResponses()
    const serve: WorkerAction = { type: 'serveRequests', requestId: 'serve-2', settings: settings() }

    await handler(serve, post)
    await handler({ type: 'stopServing', requestId: 'stop-2' }, post)

    expect(vi.mocked(closeRequestThread)).not.toHaveBeenCalled()
    expect(posts.map(response => response.type)).toEqual(['error', 'success'])
  })
})

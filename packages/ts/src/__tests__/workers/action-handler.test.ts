import { describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import { createActionHandler } from '../../workers/action-handler'
import type { Executor } from '../../workers/executor'
import type { WorkerAction, WorkerResponse } from '../../workers/protocol'

interface StubExecutor extends Executor {
  actions: WorkerAction[]
  shutdowns: number
}

function createStubExecutor(result: unknown = 'executed'): StubExecutor {
  const stub: StubExecutor = {
    actions: [],
    shutdowns: 0,
    async execute<T>(action: WorkerAction): Promise<T> {
      stub.actions.push(action)
      return result as T
    },
    async shutdown(): Promise<void> {
      stub.shutdowns += 1
    },
  }
  return stub
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

describe('the worker action handler', () => {
  it('imports the module a bootstrap action names', async () => {
    const marker = 'narsilBootstrapProof'
    const executor = createStubExecutor()
    const handler = createActionHandler(executor)
    const { posts, post } = collectResponses()

    const shouldClose = await handler(
      {
        type: 'bootstrap',
        moduleUrl: `data:text/javascript,globalThis.${marker} = true`,
        requestId: 'bootstrap-1',
      },
      post,
    )

    expect((globalThis as Record<string, unknown>)[marker]).toBe(true)
    expect(posts).toEqual([{ type: 'success', requestId: 'bootstrap-1', data: undefined }])
    expect(shouldClose).toBe(false)

    delete (globalThis as Record<string, unknown>)[marker]
  })

  it('keeps a bootstrap action away from the executor', async () => {
    const executor = createStubExecutor()
    const handler = createActionHandler(executor)
    const { post } = collectResponses()

    await handler(
      {
        type: 'bootstrap',
        moduleUrl: 'data:text/javascript,globalThis.narsilBootstrapRouting = true',
        requestId: 'bootstrap-2',
      },
      post,
    )

    expect(executor.actions).toEqual([])

    delete (globalThis as Record<string, unknown>).narsilBootstrapRouting
  })

  it('answers an empty module URL with an error rather than an import', async () => {
    const handler = createActionHandler(createStubExecutor())
    const { posts, post } = collectResponses()

    await handler({ type: 'bootstrap', moduleUrl: '   ', requestId: 'bootstrap-3' }, post)

    expect(posts).toEqual([
      {
        type: 'error',
        requestId: 'bootstrap-3',
        code: ErrorCodes.CONFIG_INVALID,
        message: 'A bootstrap module needs a non-empty module URL',
      },
    ])
  })

  it('passes every other action to the executor and returns its result', async () => {
    const executor = createStubExecutor({ count: 3 })
    const handler = createActionHandler(executor)
    const { posts, post } = collectResponses()

    const shouldClose = await handler({ type: 'count', indexName: 'prose', requestId: 'count-1' }, post)

    expect(executor.actions).toEqual([{ type: 'count', indexName: 'prose', requestId: 'count-1' }])
    expect(posts).toEqual([{ type: 'success', requestId: 'count-1', data: { count: 3 } }])
    expect(shouldClose).toBe(false)
  })

  it('reports the code an executor failure carries', async () => {
    const failing: Executor = {
      async execute<T>(): Promise<T> {
        throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, 'Index "missing" does not exist')
      },
      async shutdown(): Promise<void> {},
    }
    const handler = createActionHandler(failing)
    const { posts, post } = collectResponses()

    await handler({ type: 'count', indexName: 'missing', requestId: 'count-2' }, post)

    expect(posts).toEqual([
      {
        type: 'error',
        requestId: 'count-2',
        code: ErrorCodes.INDEX_NOT_FOUND,
        message: 'Index "missing" does not exist',
      },
    ])
  })

  it('asks the caller to close the worker after a shutdown', async () => {
    const executor = createStubExecutor()
    const handler = createActionHandler(executor)
    const { posts, post } = collectResponses()

    const shouldClose = await handler({ type: 'shutdown', requestId: 'shutdown-1' }, post)

    expect(executor.shutdowns).toBe(1)
    expect(posts).toEqual([{ type: 'success', requestId: 'shutdown-1', data: undefined }])
    expect(shouldClose).toBe(true)
  })
})

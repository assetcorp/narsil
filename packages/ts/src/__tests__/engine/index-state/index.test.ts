import { describe, expect, it } from 'vitest'
import { createIndexStateCoordinator } from '../../../engine/index-state'
import { ErrorCodes } from '../../../errors'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let settle = (): void => undefined
  const promise = new Promise<void>(resolve => {
    settle = resolve
  })
  return { promise, resolve: settle }
}

describe('index state coordinator', () => {
  it('reserves a reopened index before cap eviction yields', async () => {
    const closeStarted = deferred()
    const closeGate = deferred()
    const coordinator = createIndexStateCoordinator(
      { maxOpenIndexes: 1 },
      {
        async reopen() {},
        async close(indexName) {
          if (indexName === 'current') {
            closeStarted.resolve()
            await closeGate.promise
          }
        },
        canCloseAutomatically: () => true,
        estimateBytes: () => 1,
      },
    )
    await coordinator.registerOpen('current')
    coordinator.registerClosed('first')
    coordinator.registerClosed('second')

    const firstAcquire = coordinator.acquire('first')
    await closeStarted.promise
    const releaseSecond = await coordinator.acquire('second')

    expect(coordinator.stateOf('first')).toBe('open')
    releaseSecond()
    closeGate.resolve()
    const releaseFirst = await firstAcquire
    releaseFirst()
    coordinator.dispose()
  })

  it('never runs a recovery while a drop that followed a close deletes the index', async () => {
    const closeGate = deferred()
    const reopenCalls: string[] = []
    let dropRunning = false
    let reopenDuringDrop = false
    const coordinator = createIndexStateCoordinator(undefined, {
      async reopen(indexName) {
        reopenCalls.push(indexName)
        if (dropRunning) reopenDuringDrop = true
      },
      async close() {
        await closeGate.promise
      },
      canCloseAutomatically: () => true,
      estimateBytes: () => 1,
    })
    await coordinator.registerOpen('products')

    const closing = coordinator.close('products')
    const dropping = coordinator.drop('products', async () => {
      dropRunning = true
      await new Promise<void>(resolve => setTimeout(resolve, 10))
      dropRunning = false
    })
    const acquiring = coordinator.acquire('products')
    acquiring.catch(() => undefined)

    closeGate.resolve()
    await closing
    await dropping
    await expect(acquiring).rejects.toMatchObject({ code: ErrorCodes.INDEX_NOT_FOUND })
    expect(reopenDuringDrop).toBe(false)
    expect(reopenCalls).toHaveLength(0)
    coordinator.dispose()
  })

  it('lets an arrival parked behind a failing close proceed against the still-open index', async () => {
    const closeGate = deferred()
    const coordinator = createIndexStateCoordinator(undefined, {
      async reopen() {},
      async close() {
        await closeGate.promise
        throw new Error('checkpoint write failed')
      },
      canCloseAutomatically: () => true,
      estimateBytes: () => 1,
    })
    await coordinator.registerOpen('products')

    const closing = coordinator.close('products')
    const acquiring = coordinator.acquire('products')

    closeGate.resolve()
    await expect(closing).rejects.toThrow('checkpoint write failed')
    const release = await acquiring
    release()
    expect(coordinator.stateOf('products')).toBe('open')
    coordinator.dispose()
  })

  it('keeps an index closed when a close fails after the engine has dropped its worker copies and durability state', async () => {
    const reopenCalls: string[] = []
    const coordinator = createIndexStateCoordinator(undefined, {
      async reopen(indexName) {
        reopenCalls.push(indexName)
      },
      async close(_indexName, markIrreversible) {
        markIrreversible()
        throw new Error('replication log cleanup failed')
      },
      canCloseAutomatically: () => true,
      estimateBytes: () => 1,
    })
    await coordinator.registerOpen('products')

    await expect(coordinator.close('products')).rejects.toThrow('replication log cleanup failed')
    expect(coordinator.stateOf('products')).toBe('closed')

    const release = await coordinator.acquire('products')
    release()
    expect(reopenCalls).toEqual(['products'])
    expect(coordinator.stateOf('products')).toBe('open')
    coordinator.dispose()
  })
})

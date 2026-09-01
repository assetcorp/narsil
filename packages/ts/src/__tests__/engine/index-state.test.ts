import { describe, expect, it } from 'vitest'
import { createIndexStateCoordinator } from '../../engine/index-state'

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
})

import { describe, expect, it } from 'vitest'
import { createClusterOperationTracker } from '../../../distribution/cluster-node/operation-tracker'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let settle = (): void => undefined
  const promise = new Promise<void>(resolve => {
    settle = resolve
  })
  return { promise, resolve: settle }
}

describe('cluster operation tracker', () => {
  it('drains a composite operation and parks the next one across a transition', async () => {
    const activeGate = deferred()
    const transitionStarted = deferred()
    const transitionGate = deferred()
    const order: string[] = []
    const tracker = createClusterOperationTracker({ guard() {}, assertIndex() {} })
    const active = tracker.track('products', async () => {
      order.push('active')
      await activeGate.promise
    })
    const transition = tracker.transition('products', async () => {
      order.push('transition')
      transitionStarted.resolve()
      await transitionGate.promise
    })
    const next = tracker.track('products', async () => {
      order.push('next')
    })
    await Promise.resolve()

    expect(order).toEqual(['active'])
    activeGate.resolve()
    await active
    await transitionStarted.promise
    expect(order).toEqual(['active', 'transition'])
    transitionGate.resolve()
    await transition
    await next
    expect(order).toEqual(['active', 'transition', 'next'])
  })
})

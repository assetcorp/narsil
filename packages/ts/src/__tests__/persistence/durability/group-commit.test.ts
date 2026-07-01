import { describe, expect, it, vi } from 'vitest'
import { createGroupCommitCoordinator } from '../../../persistence/durability/group-commit'

describe('group-commit coordinator', () => {
  it('resolves a single commit through one sync', async () => {
    const sync = vi.fn(async () => undefined)
    const coordinator = createGroupCommitCoordinator(sync)
    await coordinator.commit()
    expect(sync).toHaveBeenCalledTimes(1)
  })

  it('amortises many concurrent commits arriving during one in-flight sync', async () => {
    let resolveFirst: () => void = () => undefined
    let calls = 0
    const sync = vi.fn(() => {
      calls += 1
      if (calls === 1) {
        return new Promise<void>(resolve => {
          resolveFirst = resolve
        })
      }
      return Promise.resolve()
    })

    const coordinator = createGroupCommitCoordinator(sync)
    const first = coordinator.commit()
    const batched = [coordinator.commit(), coordinator.commit(), coordinator.commit()]

    resolveFirst()
    await Promise.all([first, ...batched])

    expect(sync).toHaveBeenCalledTimes(2)
  })

  it('propagates a sync failure to every waiter in the failed batch', async () => {
    const failure = new Error('fsync failed')
    const sync = vi.fn(async () => {
      throw failure
    })
    const coordinator = createGroupCommitCoordinator(sync)

    await expect(coordinator.commit()).rejects.toBe(failure)
  })

  it('continues serving new commits after a failed batch', async () => {
    let attempt = 0
    const sync = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) {
        throw new Error('first fails')
      }
    })
    const coordinator = createGroupCommitCoordinator(sync)

    await expect(coordinator.commit()).rejects.toThrow('first fails')
    await expect(coordinator.commit()).resolves.toBeUndefined()
    expect(sync).toHaveBeenCalledTimes(2)
  })

  it('reports the number of waiters pending for the next batch', async () => {
    let release: () => void = () => undefined
    let calls = 0
    const sync = vi.fn(() => {
      calls += 1
      if (calls === 1) {
        return new Promise<void>(resolve => {
          release = resolve
        })
      }
      return Promise.resolve()
    })
    const coordinator = createGroupCommitCoordinator(sync)

    const first = coordinator.commit()
    const second = coordinator.commit()
    const third = coordinator.commit()
    expect(coordinator.pendingCount).toBe(2)

    release()
    await Promise.all([first, second, third])
  })
})

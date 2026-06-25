export type SyncFunction = () => Promise<void>

export interface GroupCommitCoordinator {
  commit(): Promise<void>
  readonly pendingCount: number
}

interface PendingBatch {
  promise: Promise<void>
  resolve: () => void
  reject: (err: unknown) => void
  waiters: number
}

export function createGroupCommitCoordinator(sync: SyncFunction): GroupCommitCoordinator {
  let inFlight: Promise<void> | null = null
  let next: PendingBatch | null = null

  function makeBatch(): PendingBatch {
    let resolve: () => void = () => undefined
    let reject: (err: unknown) => void = () => undefined
    const promise = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject, waiters: 0 }
  }

  function drain(): void {
    if (inFlight !== null || next === null) {
      return
    }
    const batch = next
    next = null
    inFlight = sync()
      .then(() => {
        batch.resolve()
      })
      .catch(err => {
        batch.reject(err)
      })
      .finally(() => {
        inFlight = null
        drain()
      })
  }

  return {
    commit(): Promise<void> {
      if (next === null) {
        next = makeBatch()
      }
      next.waiters += 1
      const promise = next.promise
      drain()
      return promise
    },

    get pendingCount(): number {
      return next === null ? 0 : next.waiters
    },
  }
}

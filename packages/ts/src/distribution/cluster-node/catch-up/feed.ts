import type { PartitionAssignment } from '../../coordinator/types'

export interface CatchUpFeed {
  readonly primaryTerm: number
  readonly inSyncSet: string
  readonly replicaStartedAt: string | undefined
  readonly whenCancelled: Promise<void>
  cancelled: boolean
  cancel(): void
}

export function inSyncSignature(assignment: PartitionAssignment): string {
  return [...assignment.inSyncSet].sort().join('\n')
}

export function createCatchUpFeed(assignment: PartitionAssignment, replicaStartedAt: string | undefined): CatchUpFeed {
  let release: () => void = () => {}
  const whenCancelled = new Promise<void>(resolve => {
    release = resolve
  })
  const feed: CatchUpFeed = {
    primaryTerm: assignment.primaryTerm,
    inSyncSet: inSyncSignature(assignment),
    replicaStartedAt,
    whenCancelled,
    cancelled: false,
    cancel: () => {
      feed.cancelled = true
      release()
    },
  }
  return feed
}

export type RegisteredNodes = Map<string, string> | null

export function feedIsStale(
  feed: CatchUpFeed,
  assignment: PartitionAssignment,
  registered: RegisteredNodes,
  replicaNodeId: string,
): boolean {
  const replicaLeft = registered !== null && registered.get(replicaNodeId) !== feed.replicaStartedAt
  return replicaLeft || assignment.primaryTerm !== feed.primaryTerm || inSyncSignature(assignment) !== feed.inSyncSet
}

export function untilCancelled<T>(feed: CatchUpFeed, work: Promise<T>, fallback: T): Promise<T> {
  if (feed.cancelled) {
    work.catch(() => {})
    return Promise.resolve(fallback)
  }
  return Promise.race([work, feed.whenCancelled.then(() => fallback)])
}

import type { ReplicationLog } from '../replication/types'

const pendingApplyByLog = new WeakMap<ReplicationLog, Promise<void>>()

export function inReplicaLogOrder<T>(log: ReplicationLog, work: () => Promise<T>): Promise<T> {
  const previous = pendingApplyByLog.get(log) ?? Promise.resolve()
  const turn = previous.then(work)
  pendingApplyByLog.set(
    log,
    turn.then(
      () => undefined,
      () => undefined,
    ),
  )
  return turn
}

import type { Etcd3 } from 'etcd3'
import type { NodeRegistration } from '../types'
import type { LeaseManager } from './leases'
import { serializeNodeRegistration } from './serialization'

export interface RegistrationWriteContext {
  client: Etcd3
  leaseManager: LeaseManager
  key: string
  ttlSeconds: number
}

/**
 * Writes a node's registration under a lease the node keeps alive, and returns once the coordinator holds it.
 *
 * A node calls this to join the cluster and again on every heartbeat. A heartbeat whose registration matches the one
 * the lease already holds renews the lease alone, because rewriting an unchanged key would make every watcher report
 * a node that never left. A renewal that fails makes the node write the registration again under a fresh lease. Two
 * calls that name one key run one at a time, so that they never grant separate leases and revoke each other's.
 *
 * @param context - The etcd client, the lease manager, the registration key, and the lease lifetime in seconds.
 * @param registration - The registration to store, which names the node and states how a peer reaches it.
 * @returns A promise that settles once the coordinator holds the registration under a live lease.
 */
export function writeNodeRegistration(
  context: RegistrationWriteContext,
  registration: NodeRegistration,
): Promise<void> {
  return context.leaseManager.runExclusively(context.key, () => writeUnderLease(context, registration))
}

async function writeUnderLease(context: RegistrationWriteContext, registration: NodeRegistration): Promise<void> {
  const payload = serializeNodeRegistration(registration)
  const data = Buffer.from(payload)
  const tracked = context.leaseManager.getByNodeId(context.key, registration.nodeId)

  if (tracked !== undefined) {
    try {
      await tracked.lease.keepaliveOnce()
      if (context.leaseManager.holdsPayload(context.key, payload)) {
        return
      }
      await tracked.lease.put(context.key).value(data).exec()
      context.leaseManager.track(context.key, tracked.lease, registration.nodeId, payload)
      return
    } catch (_) {
      context.leaseManager.remove(context.key)
    }
  }

  const lease = context.client.lease(context.ttlSeconds)
  await lease.grant()
  await lease.put(context.key).value(data).exec()

  const existing = context.leaseManager.get(context.key)
  if (existing !== undefined) {
    await existing.lease.revoke().catch(() => {})
  }
  context.leaseManager.track(context.key, lease, registration.nodeId, payload)
}

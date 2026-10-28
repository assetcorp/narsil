import type { Etcd3, Lease } from 'etcd3'
import type { NodeRegistration } from '../types'
import { RECONNECT_FIRST_DELAY_MS, RECONNECT_LONGEST_DELAY_MS } from './constants'
import type { LeaseManager } from './leases'
import type { EtcdWriteGuard } from './request-size'
import { serializeNodeRegistration } from './serialization'

export interface RegistrationWriteContext {
  client: Etcd3
  leaseManager: LeaseManager
  guard: EtcdWriteGuard
  key: string
  ttlSeconds: number
  isShutdown(): boolean
}

/**
 * Writes a node's registration under a lease the node keeps alive, and returns once the coordinator holds it.
 *
 * A node calls this to join the cluster and again on every heartbeat. A heartbeat whose registration matches the one
 * the lease already holds renews the lease alone, because rewriting an unchanged key would make every watcher report
 * a node that never left. A renewal that fails makes the node write the registration again under a fresh lease. When
 * etcd reports the lease lost between renewals, the coordinator writes the last registration again under a fresh lease
 * and retries until etcd accepts it. Two calls that name one key run one at a time, so that they never grant separate
 * leases and revoke each other's.
 *
 * @param context - The etcd client, the lease manager, the request size limit, the registration key, and the lease
 * lifetime in seconds.
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
  const write = { key: context.key, value: data, expected: null }
  context.guard.requireFits(write)
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
  try {
    await context.guard.send(write, () => lease.put(context.key).value(data).exec())
  } catch (error) {
    await lease.revoke().catch(() => {})
    throw error
  }

  const existing = context.leaseManager.get(context.key)
  if (existing !== undefined) {
    await existing.lease.revoke().catch(() => {})
  }
  context.leaseManager.track(context.key, lease, registration.nodeId, payload)
  registerAgainOnLoss(context, lease, registration.nodeId)
}

function registerAgainOnLoss(context: RegistrationWriteContext, lease: Lease, nodeId: string): void {
  lease.once('lost', () => {
    void restoreLostRegistration(context, lease, nodeId, RECONNECT_FIRST_DELAY_MS)
  })
}

async function restoreLostRegistration(
  context: RegistrationWriteContext,
  lost: Lease,
  nodeId: string,
  retryDelayMs: number,
): Promise<void> {
  const settled = await context.leaseManager.runExclusively(context.key, async () => {
    const tracked = context.leaseManager.get(context.key)
    if (context.isShutdown() || tracked === undefined || tracked.lease !== lost || tracked.payload === null) {
      return true
    }
    const lease = context.client.lease(context.ttlSeconds)
    try {
      await lease.grant()
      await lease.put(context.key).value(Buffer.from(tracked.payload)).exec()
    } catch (_) {
      await lease.revoke().catch(() => {})
      return false
    }
    context.leaseManager.track(context.key, lease, nodeId, tracked.payload)
    registerAgainOnLoss(context, lease, nodeId)
    return true
  })
  if (settled) return

  const timer = setTimeout(() => {
    void restoreLostRegistration(context, lost, nodeId, Math.min(retryDelayMs * 2, RECONNECT_LONGEST_DELAY_MS))
  }, retryDelayMs)
  timer.unref?.()
}

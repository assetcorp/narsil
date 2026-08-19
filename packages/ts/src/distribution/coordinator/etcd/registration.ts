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

export async function writeNodeRegistration(
  context: RegistrationWriteContext,
  registration: NodeRegistration,
): Promise<void> {
  const data = Buffer.from(serializeNodeRegistration(registration))
  const tracked = context.leaseManager.getByNodeId(context.key, registration.nodeId)

  if (tracked !== undefined) {
    try {
      await tracked.lease.keepaliveOnce()
      await tracked.lease.put(context.key).value(data).exec()
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
  context.leaseManager.track(context.key, lease, registration.nodeId)
}

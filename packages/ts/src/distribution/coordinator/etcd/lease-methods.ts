import type { ComparatorBuilder, Etcd3 as Etcd3Client } from 'etcd3'
import type { ClusterCoordinator } from '../types'
import type { CoordinatorKeys } from './keys'
import { grantedLease, keepLeaseAlive, type LeaseManager, renewLeaseOnce, revokeLease } from './leases'

export interface LeaseMethodContext {
  client: Etcd3Client
  keys: CoordinatorKeys
  leaseManager: LeaseManager
  assertNotShutdown(): void
}

export type LeaseMethods = Pick<ClusterCoordinator, 'acquireLease' | 'renewLease' | 'releaseLease' | 'getLeaseHolder'>

export function leaseMethods(context: LeaseMethodContext): LeaseMethods {
  const { client, keys, leaseManager, assertNotShutdown } = context
  return {
    async acquireLease(key: string, nodeId: string, ttlMs: number): Promise<boolean> {
      assertNotShutdown()
      const etcdKey = keys.lease(key)
      const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000))

      const existing = leaseManager.get(etcdKey)
      if (existing !== undefined && existing.nodeId === nodeId) {
        try {
          await renewLeaseOnce(existing.lease)
          return true
        } catch (_) {
          await leaseManager.discard(etcdKey, existing.lease)
        }
      }

      const lease = grantedLease(client, ttlSeconds)
      let txn: Awaited<ReturnType<ComparatorBuilder['commit']>>
      try {
        await lease.grant()
        txn = await client.if(etcdKey, 'Create', '==', 0).then(lease.put(etcdKey).value(nodeId)).commit()
      } catch (error) {
        await revokeLease(lease).catch(() => {})
        throw error
      }

      if (!txn.succeeded) {
        await revokeLease(lease).catch(() => {})
        const currentValue = await client.get(etcdKey).string()
        return currentValue === nodeId
      }

      keepLeaseAlive(lease, ttlSeconds)
      leaseManager.track(etcdKey, lease, nodeId)
      return true
    },

    async renewLease(key: string, nodeId: string, _ttlMs: number): Promise<boolean> {
      assertNotShutdown()
      const etcdKey = keys.lease(key)

      const entry = leaseManager.getByNodeId(etcdKey, nodeId)
      if (entry === undefined) {
        return false
      }

      try {
        await renewLeaseOnce(entry.lease)
        return true
      } catch (_) {
        await leaseManager.discard(etcdKey, entry.lease)
        return false
      }
    },

    async releaseLease(key: string): Promise<void> {
      assertNotShutdown()
      const etcdKey = keys.lease(key)
      const entry = leaseManager.remove(etcdKey)
      if (entry === undefined) {
        return
      }
      await revokeLease(entry.lease).catch(() => {})
    },

    async getLeaseHolder(key: string): Promise<string | null> {
      assertNotShutdown()
      const etcdKey = keys.lease(key)
      const value = await client.get(etcdKey).string()
      return value ?? null
    },
  }
}

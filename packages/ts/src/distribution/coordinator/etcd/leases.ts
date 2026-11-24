import type { Etcd3, Lease } from 'etcd3'
import { ETCD_CALL_TIMEOUT_MS, ETCD_LEASE_RENEWALS_PER_TTL } from './constants'
import { recordLeaseRenewal } from './lease-validity'

const MILLISECONDS_PER_SECOND = 1_000

interface ManagedLease {
  lease: Lease
  nodeId: string
  key: string
  payload: Uint8Array | null
}

function payloadsMatch(left: Uint8Array | null, right: Uint8Array): boolean {
  if (left === null || left.byteLength !== right.byteLength) {
    return false
  }
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) {
      return false
    }
  }
  return true
}

export function renewLeaseOnce(lease: Lease): ReturnType<Lease['keepaliveOnce']> {
  return lease.keepaliveOnce({ deadline: Date.now() + ETCD_CALL_TIMEOUT_MS })
}

export function grantedLease(client: Etcd3, ttlSeconds: number): Lease {
  return client.lease(ttlSeconds, { autoKeepAlive: false })
}

export function keepLeaseAlive(lease: Lease, ttlSeconds: number): void {
  let renewing = false
  const timer = setInterval(
    () => {
      if (lease.revoked()) {
        clearInterval(timer)
        return
      }
      if (renewing) return
      renewing = true
      const sentAt = performance.now()
      renewLeaseOnce(lease)
        .then(
          renewal => recordLeaseRenewal(lease, sentAt, Number(renewal.TTL)),
          () => {},
        )
        .finally(() => {
          renewing = false
        })
    },
    (ttlSeconds * MILLISECONDS_PER_SECOND) / ETCD_LEASE_RENEWALS_PER_TTL,
  )
  timer.unref?.()
}

export class LeaseManager {
  private leases = new Map<string, ManagedLease>()
  private holders = new Map<string, Lease>()
  private keyLocks = new Map<string, Promise<void>>()
  private closed = false

  track(key: string, lease: Lease, nodeId: string, payload: Uint8Array | null = null): void {
    if (this.closed) {
      void lease.revoke().catch(() => {})
      return
    }
    this.leases.set(key, { lease, nodeId, key, payload })
    this.holders.set(key, lease)
  }

  holder(key: string): Lease | undefined {
    return this.holders.get(key)
  }

  forgetHolder(key: string): void {
    this.holders.delete(key)
  }

  get(key: string): ManagedLease | undefined {
    return this.leases.get(key)
  }

  getByNodeId(key: string, nodeId: string): ManagedLease | undefined {
    const entry = this.leases.get(key)
    if (entry === undefined || entry.nodeId !== nodeId) {
      return undefined
    }
    return entry
  }

  holdsPayload(key: string, payload: Uint8Array): boolean {
    const entry = this.leases.get(key)
    return entry !== undefined && payloadsMatch(entry.payload, payload)
  }

  remove(key: string): ManagedLease | undefined {
    const entry = this.leases.get(key)
    if (entry !== undefined) {
      this.leases.delete(key)
    }
    return entry
  }

  async discard(key: string, lease: Lease): Promise<void> {
    if (this.leases.get(key)?.lease === lease) this.leases.delete(key)
    await lease.revoke().catch(() => {})
  }

  runExclusively<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.keyLocks.get(key) ?? Promise.resolve()
    const result = previous.then(work, work)
    const settled = result.then(
      () => {},
      () => {},
    )
    this.keyLocks.set(key, settled)
    void settled.then(() => {
      if (this.keyLocks.get(key) === settled) {
        this.keyLocks.delete(key)
      }
    })
    return result
  }

  async revokeAll(): Promise<void> {
    this.closed = true
    const revokePromises: Promise<void>[] = []
    for (const [, entry] of this.leases) {
      revokePromises.push(entry.lease.revoke().catch(() => {}))
    }
    this.leases.clear()
    this.holders.clear()
    await Promise.all(revokePromises)
  }

  entries(): IterableIterator<[string, ManagedLease]> {
    return this.leases.entries()
  }
}

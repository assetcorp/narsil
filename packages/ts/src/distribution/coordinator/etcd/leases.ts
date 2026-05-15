import type { Lease } from 'etcd3'

interface ManagedLease {
  lease: Lease
  nodeId: string
  key: string
}

export class LeaseManager {
  private leases = new Map<string, ManagedLease>()

  track(key: string, lease: Lease, nodeId: string): void {
    this.leases.set(key, { lease, nodeId, key })
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

  remove(key: string): ManagedLease | undefined {
    const entry = this.leases.get(key)
    if (entry !== undefined) {
      this.leases.delete(key)
    }
    return entry
  }

  async revokeAll(): Promise<void> {
    const revokePromises: Promise<void>[] = []
    for (const [, entry] of this.leases) {
      revokePromises.push(
        entry.lease.revoke().catch(() => {
          /* best-effort revocation during shutdown */
        }),
      )
    }
    this.leases.clear()
    await Promise.all(revokePromises)
  }

  entries(): IterableIterator<[string, ManagedLease]> {
    return this.leases.entries()
  }
}

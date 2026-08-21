import type { Lease } from 'etcd3'

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

export class LeaseManager {
  private leases = new Map<string, ManagedLease>()
  private keyLocks = new Map<string, Promise<void>>()

  track(key: string, lease: Lease, nodeId: string, payload: Uint8Array | null = null): void {
    this.leases.set(key, { lease, nodeId, key, payload })
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

import type { Etcd3 } from 'etcd3'
import { describe, expect, it } from 'vitest'
import { LeaseManager } from '../../../../distribution/coordinator/etcd/leases'
import { writeNodeRegistration } from '../../../../distribution/coordinator/etcd/registration'
import type { NodeRegistration } from '../../../../distribution/coordinator/types'

interface StoredKey {
  value: Buffer
  lease: FakeLease
}

class FakeLease {
  revoked = false
  keepaliveCount = 0
  putCount = 0

  constructor(
    readonly id: number,
    private readonly store: Map<string, StoredKey>,
    private readonly afterPut: (leaseId: number) => Promise<void>,
  ) {}

  async grant(): Promise<void> {
    return Promise.resolve()
  }

  async keepaliveOnce(): Promise<void> {
    if (this.revoked) {
      throw new Error(`lease ${this.id} has been revoked`)
    }
    this.keepaliveCount++
  }

  put(key: string): { value: (data: Buffer) => { exec: () => Promise<void> } } {
    return {
      value: (data: Buffer) => ({
        exec: async () => {
          this.putCount++
          this.store.set(key, { value: data, lease: this })
          await this.afterPut(this.id)
        },
      }),
    }
  }

  async revoke(): Promise<void> {
    this.revoked = true
    for (const [key, stored] of [...this.store]) {
      if (stored.lease === this) {
        this.store.delete(key)
      }
    }
  }
}

function makeClient(afterPut: (leaseId: number) => Promise<void> = () => Promise.resolve()): {
  client: Etcd3
  store: Map<string, StoredKey>
  leases: FakeLease[]
} {
  const store = new Map<string, StoredKey>()
  const leases: FakeLease[] = []
  const client = {
    lease: (_ttlSeconds: number) => {
      const lease = new FakeLease(leases.length + 1, store, afterPut)
      leases.push(lease)
      return lease
    },
  } as unknown as Etcd3
  return { client, store, leases }
}

function makeRegistration(overrides: Partial<NodeRegistration> = {}): NodeRegistration {
  return {
    nodeId: 'data-1',
    address: 'data-1.cluster.local:9200',
    roles: ['data'],
    capacity: { memoryBytes: 8_000_000_000, cpuCores: 4, diskBytes: null },
    startedAt: '2026-08-20T00:00:00Z',
    version: '1.0',
    ...overrides,
  }
}

describe('writeNodeRegistration', () => {
  const key = '_narsil/nodes/data-1'

  it('writes the registration under a fresh lease on the first call', async () => {
    const { client, store, leases } = makeClient()
    const leaseManager = new LeaseManager()

    await writeNodeRegistration({ client, leaseManager, key, ttlSeconds: 15 }, makeRegistration())

    expect(store.has(key)).toBe(true)
    expect(leases).toHaveLength(1)
    expect(leases[0].putCount).toBe(1)
  })

  it('renews the lease without rewriting an unchanged registration', async () => {
    const { client, leases } = makeClient()
    const leaseManager = new LeaseManager()
    const registration = makeRegistration()

    await writeNodeRegistration({ client, leaseManager, key, ttlSeconds: 15 }, registration)
    await writeNodeRegistration({ client, leaseManager, key, ttlSeconds: 15 }, registration)
    await writeNodeRegistration({ client, leaseManager, key, ttlSeconds: 15 }, registration)

    expect(leases).toHaveLength(1)
    expect(leases[0].keepaliveCount).toBe(2)
    expect(leases[0].putCount).toBe(1)
  })

  it('rewrites the registration once one of its fields changes', async () => {
    const { client, leases } = makeClient()
    const leaseManager = new LeaseManager()

    await writeNodeRegistration({ client, leaseManager, key, ttlSeconds: 15 }, makeRegistration())
    await writeNodeRegistration(
      { client, leaseManager, key, ttlSeconds: 15 },
      makeRegistration({ address: 'data-1.cluster.local:9300' }),
    )

    expect(leases).toHaveLength(1)
    expect(leases[0].putCount).toBe(2)
  })

  it('keeps the registration in place when two first calls overlap', async () => {
    let releaseFirstResponse = (): void => {}
    const firstResponse = new Promise<void>(resolve => {
      releaseFirstResponse = resolve
    })
    const { client, store } = makeClient(async (leaseId: number) => {
      if (leaseId === 1) {
        await firstResponse
      }
    })
    const leaseManager = new LeaseManager()
    const registration = makeRegistration()

    const first = writeNodeRegistration({ client, leaseManager, key, ttlSeconds: 15 }, registration)
    const second = writeNodeRegistration({ client, leaseManager, key, ttlSeconds: 15 }, registration)
    releaseFirstResponse()
    await Promise.all([first, second])

    expect(store.has(key)).toBe(true)
    expect(store.get(key)?.lease.revoked).toBe(false)
    expect(leaseManager.get(key)?.lease).toBe(store.get(key)?.lease)
  })

  it('replaces a lease whose renewal failed', async () => {
    const { client, store, leases } = makeClient()
    const leaseManager = new LeaseManager()
    const registration = makeRegistration()

    await writeNodeRegistration({ client, leaseManager, key, ttlSeconds: 15 }, registration)
    leases[0].revoked = true
    await writeNodeRegistration({ client, leaseManager, key, ttlSeconds: 15 }, registration)

    expect(leases).toHaveLength(2)
    expect(store.get(key)?.lease).toBe(leases[1])
  })
})

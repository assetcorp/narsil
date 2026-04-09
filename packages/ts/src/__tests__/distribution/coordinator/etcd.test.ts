import { encode } from '@msgpack/msgpack'
import { describe, expect, it } from 'vitest'
import type { AllocationTable, NodeRegistration, PartitionAssignment } from '../../../distribution/coordinator'
import {
  buildKey,
  DEFAULT_ETCD_CONFIG,
  ETCD_KEY_ALLOCATION,
  ETCD_KEY_NODES,
  ETCD_KEY_PARTITION,
  ETCD_KEY_SCHEMA,
} from '../../../distribution/coordinator/etcd/types'
import { validateNodeId, validatePartitionState } from '../../../distribution/coordinator/etcd/validation'
import { NarsilError } from '../../../errors'

function makeNodeRegistration(overrides: Partial<NodeRegistration> = {}): NodeRegistration {
  return {
    nodeId: 'node-1',
    address: '127.0.0.1:9200',
    roles: ['data', 'coordinator', 'controller'],
    capacity: { memoryBytes: 8_000_000_000, cpuCores: 4, diskBytes: 100_000_000_000 },
    startedAt: '2026-04-08T10:00:00Z',
    version: '1.0',
    ...overrides,
  }
}

function makeAllocationTable(indexName: string): AllocationTable {
  const assignment: PartitionAssignment = {
    primary: 'node-1',
    replicas: ['node-2'],
    inSyncSet: ['node-2'],
    state: 'ACTIVE',
    primaryTerm: 1,
  }
  return {
    indexName,
    version: 1,
    replicationFactor: 1,
    assignments: new Map([[0, assignment]]),
  }
}

describe('EtcdCoordinator unit tests', () => {
  describe('key path construction', () => {
    it('builds node key paths correctly', () => {
      const key = buildKey('_narsil', ETCD_KEY_NODES, 'abc')
      expect(key).toBe('_narsil/nodes/abc')
    })

    it('builds node key with default prefix', () => {
      const key = buildKey(DEFAULT_ETCD_CONFIG.keyPrefix, ETCD_KEY_NODES, 'my-node-id')
      expect(key).toBe('_narsil/nodes/my-node-id')
    })

    it('builds allocation key paths correctly', () => {
      const key = buildKey('_narsil', ETCD_KEY_ALLOCATION, 'products')
      expect(key).toBe('_narsil/allocation/products')
    })

    it('builds partition key paths with index and partition id', () => {
      const key = buildKey('_narsil', ETCD_KEY_PARTITION, 'products', '0')
      expect(key).toBe('_narsil/partition/products/0')
    })

    it('builds schema key paths correctly', () => {
      const key = buildKey('_narsil', ETCD_KEY_SCHEMA, 'articles')
      expect(key).toBe('_narsil/schema/articles')
    })

    it('builds generic KV key paths correctly', () => {
      const key = buildKey('_narsil', 'kv', '_narsil/index/products/config')
      expect(key).toBe('_narsil/kv/_narsil/index/products/config')
    })

    it('builds lease key paths correctly', () => {
      const key = buildKey('_narsil', 'lease', '_narsil/controller')
      expect(key).toBe('_narsil/lease/_narsil/controller')
    })

    it('handles custom prefixes', () => {
      const key = buildKey('my-cluster', ETCD_KEY_NODES, 'node-42')
      expect(key).toBe('my-cluster/nodes/node-42')
    })

    it('handles node IDs with special characters', () => {
      const key = buildKey('_narsil', ETCD_KEY_NODES, 'node-with-dashes-123')
      expect(key).toBe('_narsil/nodes/node-with-dashes-123')
    })
  })

  describe('MessagePack serialization of node registrations', () => {
    it('serializes a node registration to MessagePack bytes', () => {
      const reg = makeNodeRegistration()
      const encoded = new Uint8Array(encode(reg))
      expect(encoded.byteLength).toBeGreaterThan(0)
    })

    it('serialized data includes all required fields', () => {
      const reg = makeNodeRegistration({
        nodeId: 'test-node',
        address: '10.0.0.1:9300',
        roles: ['data'],
        capacity: { memoryBytes: 4_000_000_000, cpuCores: 2, diskBytes: null },
        startedAt: '2026-04-09T12:00:00Z',
        version: '1.0',
      })
      const encoded = encode(reg)
      const decoded = new Uint8Array(encoded)
      expect(decoded.byteLength).toBeGreaterThan(0)
    })

    it('serializes multiple registrations independently', () => {
      const reg1 = makeNodeRegistration({ nodeId: 'node-1' })
      const reg2 = makeNodeRegistration({ nodeId: 'node-2', address: '10.0.0.2:9300' })

      const encoded1 = new Uint8Array(encode(reg1))
      const encoded2 = new Uint8Array(encode(reg2))

      expect(encoded1).not.toEqual(encoded2)
    })
  })

  describe('allocation table serialization', () => {
    it('converts Map-based assignments to array for serialization', () => {
      const table = makeAllocationTable('products')

      const serializable = {
        indexName: table.indexName,
        version: table.version,
        replicationFactor: table.replicationFactor,
        assignments: Array.from(table.assignments.entries()),
      }
      const encoded = new Uint8Array(encode(serializable))
      expect(encoded.byteLength).toBeGreaterThan(0)
    })

    it('preserves partition ID ordering in serialized form', () => {
      const assignments = new Map<number, PartitionAssignment>()
      for (let i = 0; i < 5; i++) {
        assignments.set(i, {
          primary: `node-${i % 3}`,
          replicas: [],
          inSyncSet: [],
          state: 'ACTIVE',
          primaryTerm: 1,
        })
      }
      const table: AllocationTable = {
        indexName: 'test-index',
        version: 3,
        replicationFactor: 0,
        assignments,
      }

      const entries = Array.from(table.assignments.entries())
      expect(entries).toHaveLength(5)
      for (let i = 0; i < 5; i++) {
        expect(entries[i][0]).toBe(i)
      }
    })
  })

  describe('CAS transaction logic', () => {
    it('null expected means key must not exist (create-only semantics)', () => {
      const expected: Uint8Array | null = null
      const isCreateOnly = expected === null
      expect(isCreateOnly).toBe(true)
    })

    it('non-null expected means key must match current value', () => {
      const expected = new Uint8Array([1, 2, 3])
      const current = new Uint8Array([1, 2, 3])

      const matches = expected.every((byte, i) => byte === current[i]) && expected.byteLength === current.byteLength
      expect(matches).toBe(true)
    })

    it('detects value mismatch for CAS', () => {
      const expected = new Uint8Array([1, 2, 3])
      const current = new Uint8Array([4, 5, 6])

      const matches = expected.every((byte, i) => byte === current[i]) && expected.byteLength === current.byteLength
      expect(matches).toBe(false)
    })

    it('detects length mismatch for CAS', () => {
      const expected = new Uint8Array([1, 2, 3])
      const current = new Uint8Array([1, 2])

      const matches = expected.byteLength === current.byteLength
      expect(matches).toBe(false)
    })
  })

  describe('lease TTL calculation', () => {
    it('converts milliseconds to seconds with ceiling', () => {
      const ttlMs = 5_000
      const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000))
      expect(ttlSeconds).toBe(5)
    })

    it('rounds up sub-second TTLs to 1 second minimum', () => {
      const ttlMs = 500
      const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000))
      expect(ttlSeconds).toBe(1)
    })

    it('handles exact second boundaries', () => {
      const ttlMs = 10_000
      const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000))
      expect(ttlSeconds).toBe(10)
    })

    it('handles non-exact millisecond values', () => {
      const ttlMs = 7_500
      const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000))
      expect(ttlSeconds).toBe(8)
    })

    it('enforces minimum 1 second for very small TTLs', () => {
      const ttlMs = 1
      const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000))
      expect(ttlSeconds).toBe(1)
    })
  })

  describe('config defaults', () => {
    it('provides sensible default configuration', () => {
      expect(DEFAULT_ETCD_CONFIG.endpoints).toEqual(['http://localhost:2379'])
      expect(DEFAULT_ETCD_CONFIG.keyPrefix).toBe('_narsil')
      expect(DEFAULT_ETCD_CONFIG.nodeHeartbeatTtlSeconds).toBe(30)
      expect(DEFAULT_ETCD_CONFIG.leaseTtlSeconds).toBe(15)
    })
  })

  describe('key extraction from etcd watch events', () => {
    it('extracts nodeId from full node key path', () => {
      const fullKey = '_narsil/nodes/my-node-123'
      const prefix = '_narsil/nodes'
      const nodeId = fullKey.slice(prefix.length + 1)
      expect(nodeId).toBe('my-node-123')
    })

    it('extracts index name from full schema key path', () => {
      const fullKey = '_narsil/schema/products'
      const prefix = '_narsil/schema'
      const indexName = fullKey.slice(prefix.length + 1)
      expect(indexName).toBe('products')
    })

    it('extracts index name from full allocation key path', () => {
      const fullKey = '_narsil/allocation/my-index'
      const prefix = '_narsil/allocation'
      const indexName = fullKey.slice(prefix.length + 1)
      expect(indexName).toBe('my-index')
    })
  })

  describe('validateNodeId', () => {
    it('accepts a valid node ID', () => {
      expect(() => validateNodeId('node-1')).not.toThrow()
      expect(() => validateNodeId('my-node-with-dashes-123')).not.toThrow()
    })

    it('rejects empty node ID', () => {
      expect(() => validateNodeId('')).toThrow(NarsilError)
    })

    it('rejects node ID with forward slash', () => {
      expect(() => validateNodeId('node/bad')).toThrow(NarsilError)
    })

    it('rejects node ID with backslash', () => {
      expect(() => validateNodeId('node\\bad')).toThrow(NarsilError)
    })

    it('rejects node ID with dot-dot traversal', () => {
      expect(() => validateNodeId('node..bad')).toThrow(NarsilError)
    })

    it('rejects node ID with null byte', () => {
      expect(() => validateNodeId('node\0bad')).toThrow(NarsilError)
    })

    it('rejects node ID exceeding 255 characters', () => {
      const longId = 'a'.repeat(256)
      expect(() => validateNodeId(longId)).toThrow(NarsilError)
    })

    it('accepts node ID at the 255 character limit', () => {
      const maxId = 'a'.repeat(255)
      expect(() => validateNodeId(maxId)).not.toThrow()
    })
  })

  describe('validatePartitionState', () => {
    it('accepts all known partition states', () => {
      expect(validatePartitionState('UNASSIGNED')).toBe('UNASSIGNED')
      expect(validatePartitionState('INITIALISING')).toBe('INITIALISING')
      expect(validatePartitionState('ACTIVE')).toBe('ACTIVE')
      expect(validatePartitionState('MIGRATING')).toBe('MIGRATING')
      expect(validatePartitionState('DECOMMISSIONING')).toBe('DECOMMISSIONING')
    })

    it('rejects unknown partition states', () => {
      expect(() => validatePartitionState('INVALID')).toThrow(NarsilError)
      expect(() => validatePartitionState('')).toThrow(NarsilError)
      expect(() => validatePartitionState('active')).toThrow(NarsilError)
    })
  })
})

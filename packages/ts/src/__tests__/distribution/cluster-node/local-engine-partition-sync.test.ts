import { describe, expect, it } from 'vitest'
import { createClusterLocalEngine } from '../../../distribution/cluster-node/local-engine'
import { resolvePartitionId } from '../../../distribution/cluster-node/write-routing'
import type { SchemaDefinition } from '../../../types/schema'

function docIdForPartition(partitionId: number, partitionCount: number, prefix: string): string {
  for (let i = 0; i < 10_000; i += 1) {
    const candidate = `${prefix}-${i}`
    if (resolvePartitionId(candidate, partitionCount) === partitionId) {
      return candidate
    }
  }
  throw new Error(`could not find document id for partition ${partitionId}`)
}

describe('ClusterLocalEngine partition snapshot restore', () => {
  it('restores only the target partition without clobbering other local data', async () => {
    const engine = await createClusterLocalEngine()
    const schema: SchemaDefinition = { title: 'string' }
    const auditSchema: SchemaDefinition = { name: 'string' }

    try {
      await engine.createIndex('products', { schema, partitions: { maxPartitions: 2 } })
      await engine.createIndex('audit', { schema: auditSchema })

      const partitionZeroDocId = docIdForPartition(0, 2, 'product-p0')
      const partitionOneDocId = docIdForPartition(1, 2, 'product-p1')
      await engine.insert('products', { title: 'partition zero' }, partitionZeroDocId)
      await engine.insert('products', { title: 'partition one' }, partitionOneDocId)
      await engine.insert('audit', { name: 'keep audit' }, 'audit-1')

      const partitionSnapshot = await engine.serializeReplicationPartition('products', 0)
      await engine.remove('products', partitionZeroDocId)

      await engine.restoreReplicationPartition('products', 0, partitionSnapshot, schema, 2)

      await expect(engine.get('products', partitionZeroDocId)).resolves.toEqual({ title: 'partition zero' })
      await expect(engine.get('products', partitionOneDocId)).resolves.toEqual({ title: 'partition one' })
      await expect(engine.get('audit', 'audit-1')).resolves.toEqual({ name: 'keep audit' })
      expect(engine.getStats('products').partitionCount).toBe(2)
    } finally {
      await engine.shutdown()
    }
  })
})

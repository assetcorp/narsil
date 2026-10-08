import { describe, expect, it } from 'vitest'
import { ensureLocalIndexForIncremental } from '../../../../distribution/cluster-node/bootstrap-sync/apply'
import type { LiveBootstrapSyncDeps } from '../../../../distribution/cluster-node/bootstrap-sync/types'
import { createClusterLocalEngine } from '../../../../distribution/cluster-node/local-engine'
import { ErrorCodes } from '../../../../errors'
import type { EmbeddingAdapter } from '../../../../types/adapters'

describe('a replica that bootstraps a partition from replication log entries', () => {
  it('creates its missing copy with the settings that the coordinator stores', async () => {
    const engine = await createClusterLocalEngine({ workers: { enabled: false } })
    const deps = { engine } as unknown as LiveBootstrapSyncDeps

    try {
      const result = await ensureLocalIndexForIncremental(
        'products',
        'node-primary',
        { schema: { title: 'string', sku: 'verbatim' }, language: 'english', patternValueLimit: 4, strict: true },
        2,
        deps,
      )

      expect(result).toEqual({ created: true })
      expect(engine.getStats('products').partitionCount).toBe(2)
      await expect(engine.insert('products', { title: 'Desk', sku: 'DESK-01' }, 'desk')).rejects.toMatchObject({
        code: ErrorCodes.DOC_VALIDATION_FAILED,
      })
      await expect(
        engine.insert('products', { title: 'Lamp', sku: 'LAMP', colour: 'red' }, 'lamp'),
      ).rejects.toMatchObject({ code: ErrorCodes.DOC_VALIDATION_FAILED })
      await expect(engine.insert('products', { title: 'Lamp', sku: 'LAMP' }, 'lamp')).resolves.toBe('lamp')
    } finally {
      await engine.shutdown()
    }
  })

  it('creates its copy without the embedding adapter and binds the adapter once a caller registers it', async () => {
    const engine = await createClusterLocalEngine({ workers: { enabled: false } })
    const deps = { engine } as unknown as LiveBootstrapSyncDeps
    const embedder: EmbeddingAdapter = { dimensions: 3, embed: async () => new Float32Array([0.6, 0.8, 0]) }

    try {
      const result = await ensureLocalIndexForIncremental(
        'articles',
        'node-primary',
        {
          schema: { body: 'string', embedding: 'vector[3]' },
          language: 'english',
          embedding: { adapter: 'article-embedder', fields: { embedding: 'body' } },
        },
        1,
        deps,
      )

      expect(result).toEqual({ created: true })
      await expect(engine.insert('articles', { body: 'Tide tables' }, 'tides')).rejects.toMatchObject({
        code: ErrorCodes.EMBEDDING_CONFIG_INVALID,
      })
      engine.registerEmbeddingAdapter('article-embedder', embedder)
      await expect(engine.insert('articles', { body: 'Tide tables' }, 'tides')).resolves.toBe('tides')
    } finally {
      await engine.shutdown()
    }
  })
})

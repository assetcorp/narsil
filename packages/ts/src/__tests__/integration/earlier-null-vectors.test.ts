import { readFile } from 'node:fs/promises'
import { decode, encode } from '@msgpack/msgpack'
import { expect, it } from 'vitest'
import { createNarsil } from '../../narsil'
import { bytesOf, resealed } from '../e2e/portability/archive-oracle'

it('preserves null vector fields when restoring an earlier snapshot and saving it again', async () => {
  const source = new URL('../../../../conformance/samples/earlier-releases/0.3.0/products-0.3.0.nrsl', import.meta.url)
  const snapshot = resealed(await readFile(source), payload => {
    const schema = payload.schema as Record<string, string>
    schema['meta.embedding'] = 'vector[2]'
    payload.vectorIndexes = {}
    payload.partitions = (payload.partitions as Uint8Array[]).map(bytes => {
      const partition = decode(bytes) as {
        schema: Record<string, string>
        documents: Record<string, { fields: Record<string, unknown> }>
      }
      partition.schema['meta.embedding'] = 'vector[2]'
      for (const document of Object.values(partition.documents)) {
        document.fields.embedding = null
        document.fields.meta = { embedding: null }
      }
      return encode(partition)
    })
    return payload
  })
  const engine = await createNarsil({ workers: { enabled: false } })
  try {
    await engine.restore('earlier', snapshot)
    await engine.restore('saved', await bytesOf(await engine.snapshot('earlier')))
    for (const index of ['earlier', 'saved']) {
      const shown = await engine.get(index, 'doc-0001', { document: { vectors: true } })
      expect(shown).toMatchObject({ embedding: null, meta: { embedding: null } })
      const hidden = await engine.get(index, 'doc-0001')
      expect(hidden).not.toHaveProperty('embedding')
      expect(hidden?.meta).toEqual({})
      const queried = await engine.query(index, {
        term: 'basalt',
        document: { include: ['embedding', 'meta.embedding'] },
      })
      expect(queried.hits.length).toBeGreaterThan(0)
      for (const hit of queried.hits) expect(hit.document).toEqual({ embedding: null, meta: { embedding: null } })
    }
  } finally {
    await engine.shutdown()
  }
})

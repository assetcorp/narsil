import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decode } from '@msgpack/msgpack'
import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import type { NarsilConfig } from '../../../types/config'
import { openEnvelope } from './archive-oracle'
import { temporaryRoots } from './harness'

const roots = temporaryRoots()
const engines: Narsil[] = []
const VECTORS_PER_GRAPH_PART = 16_384
const VECTORS = VECTORS_PER_GRAPH_PART + 700

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown().catch(() => undefined)
  await roots.removeAll()
})

function vectorOf(seed: number): number[] {
  return [Math.fround(Math.cos(seed * 0.61)), Math.fround(Math.sin(seed * 1.37))]
}

describe('a vector graph of more vectors than one graph part holds', () => {
  it('writes full parts of 16,384 vectors and a shorter last part, and reads the graph back whole', async () => {
    const directory = await roots.make('narsil-graph-parts-')
    const config: NarsilConfig = { workers: { enabled: false }, durability: { directory } }
    const engine = await createNarsil(config)
    engines.push(engine)
    await engine.createIndex('points', {
      schema: { embedding: 'vector[2]' },
      vectorPromotion: { threshold: 64, quantization: 'none', hnswConfig: { m: 4, efConstruction: 16 } },
    })
    for (let start = 0; start < VECTORS; start += 2_000) {
      const batch = []
      for (let n = start; n < Math.min(VECTORS, start + 2_000); n++) batch.push({ id: `v${n}`, embedding: vectorOf(n) })
      expect((await engine.insertBatch('points', batch)).failed).toEqual([])
    }
    await engine.optimizeVectors('points', 'embedding')
    await engine.checkpoint('points')
    const queries = [17, 4_000, 16_500].map(seed => ({
      vector: { field: 'embedding', value: vectorOf(seed) },
      limit: 3,
    }))
    const expected = []
    for (const query of queries) expected.push((await engine.query('points', query)).hits.map(hit => hit.id))
    await engine.shutdown()

    const segments = join(directory, 'points', 'segments')
    const parts = (await readdir(segments)).filter(name => /-graph-g\d+-p\d{16}$/.test(name)).sort()
    expect(parts).toHaveLength(2)
    const levels = []
    for (const part of parts) {
      const payload = decode(openEnvelope(new Uint8Array(await readFile(join(segments, part)))).payload) as {
        v: number
        graphs: Array<{ levels: Uint8Array }>
      }
      expect(payload.v).toBe(2)
      levels.push(payload.graphs[0].levels.byteLength)
    }
    expect(levels).toEqual([VECTORS_PER_GRAPH_PART, VECTORS - VECTORS_PER_GRAPH_PART])

    const reopened = await createNarsil(config)
    engines.push(reopened)
    expect((await reopened.vectorMaintenanceStatus('points'))[0]).toMatchObject({ graphCount: 1, bufferSize: 0 })
    for (const [at, query] of queries.entries()) {
      expect((await reopened.query('points', query)).hits.map(hit => hit.id)).toEqual(expected[at])
    }
  }, 180_000)
})

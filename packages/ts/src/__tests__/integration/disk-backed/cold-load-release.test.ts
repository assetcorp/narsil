import { fstatSync, readdirSync, readlinkSync } from 'node:fs'
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import { manifestKey } from '../../../persistence/durability/segment/layout'
import { encodeSegmentManifest } from '../../../persistence/durability/segment/manifest-encode'
import { requireManifestOnDisk } from '../../persistence/durability/manifest-on-disk'

const INDEX = 'passages'
const DOCUMENTS = 300
const DAMAGED_GRAPH_BYTES = 128 * 1024 * 1024
const LOAD_WAIT_MS = 10_000

function handlesUnder(root: string): string[] {
  return readdirSync('/proc/self/fd').flatMap(fd => {
    try {
      const target = readlinkSync(`/proc/self/fd/${fd}`)
      return target.startsWith(root) && fstatSync(Number(fd)).isFile() ? [target] : []
    } catch {
      return []
    }
  })
}

it.skipIf(process.platform !== 'linux').each(['clear', 'shutdown', 'clear during rerank', 'drop after rerank'])(
  'closes a cancelled graph read after %s',
  async action => {
    const root = await mkdtemp(join(tmpdir(), 'narsil-cold-release-'))
    const config = { durability: { directory: root }, workers: { enabled: false } }
    let engine = await createNarsil(config)
    try {
      await engine.createIndex(INDEX, {
        schema: { title: 'string', embedding: 'vector[4]' },
        textStorage: 'disk',
        vectorPromotion: { threshold: 16, storage: 'disk' },
      })
      const inserted = await engine.insertBatch(
        INDEX,
        Array.from({ length: DOCUMENTS }, (_, at) => ({
          id: `passage-${at}`,
          title: `passage ${at}`,
          embedding: [1, at / DOCUMENTS, 0, 0],
        })),
      )
      expect(inserted.failed).toEqual([])
      await engine.optimizeVectors(INDEX)
      await engine.checkpoint(INDEX)
      await engine.shutdown()
      const manifest = await requireManifestOnDisk(root, INDEX)
      const graph = manifest.vectors[0]?.graphParts[0]
      if (graph === undefined) throw new Error('The checkpoint holds no graph')
      const graphPath = join(root, graph.key)
      await truncate(graphPath, DAMAGED_GRAPH_BYTES)
      graph.bytes = DAMAGED_GRAPH_BYTES
      const packed = await encodeSegmentManifest(manifest)
      await writeFile(join(root, manifestKey(INDEX)), Buffer.concat(packed.chunks))
      engine = await createNarsil(config)
      expect(engine.vectorMaintenanceStatus(INDEX)[0]?.loadingFromFiles).toBe(true)
      const handlesBeforeLoad = handlesUnder(root).filter(path => path === graphPath).length
      await engine.query(INDEX, { vector: { field: 'embedding', value: [1, 0, 0, 0] }, limit: 0 })
      const deadline = Date.now() + LOAD_WAIT_MS
      while (handlesUnder(root).filter(path => path === graphPath).length <= handlesBeforeLoad) {
        if (Date.now() > deadline) throw new Error('The cold loader never opened the graph')
        await nextTurn()
      }
      if (action === 'clear') {
        await engine.clear(INDEX)
        expect(handlesUnder(graphPath)).toEqual([])
        expect(await engine.countDocuments(INDEX)).toBe(0)
      } else if (action === 'clear during rerank' || action === 'drop after rerank') {
        engine.registerRerankAdapter('clearing', {
          async rerank(_query, texts) {
            await engine.clear(INDEX)
            return texts.map(() => 1)
          },
        })
        const found = await engine.query(INDEX, {
          term: 'passage',
          rerank: { adapter: 'clearing', fields: ['title'] },
        })
        const expected = Array.from({ length: DOCUMENTS }, (_, at) => `passage-${at}`)
          .sort()
          .slice(0, 10)
        expect(found.hits.map(hit => hit.id)).toEqual(expected)
        for (const hit of found.hits) {
          expect(hit.score).toBe(1)
          expect(hit.document?.title).toBe(`passage ${Number(hit.id.slice('passage-'.length))}`)
        }
        expect(await engine.countDocuments(INDEX)).toBe(0)
      }
      if (action === 'drop after rerank') {
        await engine.dropIndex(INDEX)
        expect(handlesUnder(join(root, INDEX))).toEqual([])
      }
      await engine.shutdown()
      expect(handlesUnder(root)).toEqual([])
      if (action === 'clear' || action === 'clear during rerank') {
        for (let restart = 0; restart < 3; restart++) {
          engine = await createNarsil(config)
          expect(await engine.countDocuments(INDEX)).toBe(0)
          await engine.shutdown()
          expect(handlesUnder(root)).toEqual([])
        }
      }
    } finally {
      await engine.shutdown()
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)

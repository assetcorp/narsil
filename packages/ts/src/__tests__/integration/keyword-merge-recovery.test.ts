import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { AnyDocument } from '../../types/schema'

const DOCUMENTS_PER_BATCH = 240
const BATCHES = 9
const INDEX = 'minerals'

function documentAt(at: number): AnyDocument {
  const document: AnyDocument = { id: `mineral-${String(at).padStart(5, '0')}`, ordinal: at }
  if (at % 4 === 0) document.title = 'quartz stone'
  if (at % 4 === 1) document.body = 'stone quartz'
  if (at % 4 === 2) {
    document.title = 'stone'
    document.body = 'quartz stone'
  }
  if (at % 4 === 3) document.tags = ['quartz', 'stone']
  return document
}

async function verify(engine: Narsil, documents: ReadonlyMap<string, AnyDocument>): Promise<void> {
  const all = [...documents.values()]
  expect(await engine.countDocuments(INDEX)).toBe(all.length)
  const fields = ['title', 'body', 'tags']
  for (const field of fields) {
    const expected = all
      .filter(document => {
        const value = document[field]
        return typeof value === 'string'
          ? value.split(' ').includes('quartz')
          : Array.isArray(value) && value.includes('quartz')
      })
      .map(document => String(document.id))
      .sort()
    const found = await engine.query(INDEX, { term: 'quartz', fields: [field], limit: 10_000 })
    expect(found.hits.map(hit => hit.id).sort()).toEqual(expected)
    for (const hit of found.hits) expect(hit.document).toEqual(documents.get(hit.id))
  }
  const phraseIds = all
    .filter(document =>
      fields.some(field => {
        const value = document[field]
        return typeof value === 'string' && value.includes('quartz stone')
      }),
    )
    .map(document => String(document.id))
    .sort()
  expect((await engine.query(INDEX, { term: '"quartz stone"', limit: 10_000 })).hits.map(hit => hit.id).sort()).toEqual(
    phraseIds,
  )
  expect((await engine.preflight(INDEX, { term: '"quartz stone"' })).count).toBe(phraseIds.length)
  const partial = await engine.query(INDEX, { term: 'uart', partialWords: true, limit: 10_000 })
  expect(partial.hits.map(hit => hit.id).sort()).toEqual([...documents.keys()].sort())
}

it('keeps field remapping, phrase positions, and partial spellings through worker compaction and durable merges', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'narsil-keyword-merge-'))
  let engine: Narsil | undefined
  try {
    engine = await createNarsil({
      workers: { enabled: true, count: 2, promotionThreshold: 2, mainCopyQueries: 'none' },
      durability: { directory, compactionThreshold: 1 },
    })
    await engine.createIndex(INDEX, {
      schema: { title: 'string:partial', body: 'string:partial', tags: 'string[]:partial', ordinal: 'number' },
      language: 'english',
      trackPositions: true,
      partitions: { maxPartitions: 1 },
    })
    const held = new Map<string, AnyDocument>()
    for (let batch = 0; batch < BATCHES; batch++) {
      const documents = Array.from({ length: DOCUMENTS_PER_BATCH }, (_, at) =>
        documentAt(batch * DOCUMENTS_PER_BATCH + at),
      )
      expect((await engine.insertBatch(INDEX, documents)).failed).toEqual([])
      for (const document of documents) held.set(String(document.id), document)
    }
    for (let at = 0; at < DOCUMENTS_PER_BATCH * BATCHES; at += 13) {
      const id = String(documentAt(at).id)
      await engine.remove(INDEX, id)
      held.delete(id)
    }
    await engine.waitForWrites(INDEX)
    await verify(engine, held)
    await engine.checkpoint(INDEX)
    await engine.shutdown()
    engine = await createNarsil({ workers: { enabled: false }, durability: { directory, compactionThreshold: 1 } })
    await verify(engine, held)
    for (let at = 1; at < DOCUMENTS_PER_BATCH * BATCHES; at += 17) {
      const document = { ...documentAt(at), title: 'quartz stone', body: '', tags: [] }
      if (held.has(String(document.id))) await engine.update(INDEX, String(document.id), document)
      else await engine.insert(INDEX, document, String(document.id))
      held.set(String(document.id), document)
    }
    await engine.checkpoint(INDEX)
    await engine.shutdown()
    engine = await createNarsil({ workers: { enabled: false }, durability: { directory } })
    await verify(engine, held)
  } finally {
    await engine?.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
}, 120_000)

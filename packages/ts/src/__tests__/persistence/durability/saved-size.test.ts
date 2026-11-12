import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import type { NarsilConfig } from '../../../types/config'
import { bytesOf } from '../../e2e/portability/archive-oracle'
import { bodyOf, expectDocumentsOf, expectFiguresMatchTheFiles, savedBytesAllowedFor } from './saved-size-oracle'

const built = existsSync(new URL('../../../../dist/index.mjs', import.meta.url))
const INDEX = 'docs'
const DOCUMENTS = 2400
const BODY_LENGTH = 1200
const REMOVED = 1000
const UPDATED = 300

interface Layout {
  name: string
  textStorage: 'memory' | 'disk'
  workers: boolean
}

const LAYOUTS: Layout[] = [
  { name: 'text in memory without worker copies', textStorage: 'memory', workers: false },
  { name: 'text on disk with worker copies', textStorage: 'disk', workers: true },
]

function vectorOf(seed: number): number[] {
  return [Math.sin(seed), Math.cos(seed), Math.sin(seed * 2), Math.cos(seed * 3)]
}

function configFor(directory: string, layout: Layout): NarsilConfig {
  return {
    durability: { directory, checkpointIntervalMs: 0, checkpointMutationThreshold: 1_000_000_000 },
    workers: { enabled: layout.workers },
  }
}

async function insertDocuments(engine: Narsil, expected: Map<string, string>): Promise<void> {
  for (let start = 0; start < DOCUMENTS; start += 400) {
    const batch = []
    for (let at = start; at < start + 400; at++) {
      const body = bodyOf(at, BODY_LENGTH)
      batch.push({ id: `doc-${at}`, title: `title ${at}`, body, embedding: vectorOf(at) })
      expected.set(`doc-${at}`, body)
    }
    await engine.insertBatch(INDEX, batch)
  }
}

describe.each(LAYOUTS)('the saved size of an index with $name', layout => {
  let directory: string
  let engine: Narsil | null = null

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-saved-size-'))
  })

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
    await rm(directory, { recursive: true, force: true })
  })

  it.skipIf(layout.workers && !built)(
    'equals the files that its checkpoint lists, and falls once removals pass the share, with no further write',
    async () => {
      const config = configFor(directory, layout)
      engine = await createNarsil(config)
      await engine.createIndex(INDEX, {
        schema: { title: 'string', body: 'string', embedding: 'vector[4]' },
        textStorage: layout.textStorage,
      })
      const expected = new Map<string, string>()
      await insertDocuments(engine, expected)
      await engine.checkpoint(INDEX)
      await expectFiguresMatchTheFiles(engine, directory, INDEX)
      const savedAfterInsert = engine.getStats(INDEX).savedBytes ?? 0
      const bytesPerDocument = savedAfterInsert / DOCUMENTS

      const removed: string[] = []
      for (let at = 0; at < REMOVED * 2; at += 2) removed.push(`doc-${at}`)
      await engine.removeBatch(INDEX, removed)
      for (const docId of removed) expected.delete(docId)
      const updates = []
      for (let at = 1; at < UPDATED * 2; at += 2) {
        const body = bodyOf(at + DOCUMENTS, BODY_LENGTH)
        updates.push({ docId: `doc-${at}`, document: { title: `title ${at}`, body, embedding: vectorOf(at) } })
        expected.set(`doc-${at}`, body)
      }
      await engine.updateBatch(INDEX, updates)
      await engine.checkpoint(INDEX)
      for (let round = 0; round < 3; round++) await engine.checkpoint(INDEX)

      const savedAfterRemovals = engine.getStats(INDEX).savedBytes ?? Number.POSITIVE_INFINITY
      expect(savedAfterRemovals).toBeLessThan(savedAfterInsert)
      expect(savedAfterRemovals).toBeLessThanOrEqual(savedBytesAllowedFor(expected.size, bytesPerDocument))
      await expectDocumentsOf(engine, INDEX, expected, removed)

      await engine.shutdown()
      engine = await createNarsil(config)
      expect(engine.getStats(INDEX).savedBytes).toBe(savedAfterRemovals)
      await expectFiguresMatchTheFiles(engine, directory, INDEX)
      await expectDocumentsOf(engine, INDEX, expected, removed)

      for (let round = 0; round < 3; round++) await engine.checkpoint(INDEX)
      expect(engine.getStats(INDEX).savedBytes).toBe(savedAfterRemovals)
    },
    120_000,
  )
})

describe('the saved size after a snapshot restore', () => {
  let directory: string
  let engine: Narsil | null = null

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-saved-size-restore-'))
  })

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
    await rm(directory, { recursive: true, force: true })
  })

  it('equals the restored files, and keeps its figure through a restore that fails', async () => {
    const config = configFor(directory, { name: 'memory', textStorage: 'memory', workers: false })
    engine = await createNarsil(config)
    await engine.createIndex(INDEX, { schema: { title: 'string', body: 'string', embedding: 'vector[4]' } })
    const expected = new Map<string, string>()
    await insertDocuments(engine, expected)
    const snapshot = await bytesOf(await engine.snapshot(INDEX))
    const removed: string[] = []
    for (let at = 0; at < DOCUMENTS; at += 3) removed.push(`doc-${at}`)
    await engine.removeBatch(INDEX, removed)
    await engine.checkpoint(INDEX)
    const savedBeforeRestore = engine.getStats(INDEX).savedBytes

    await expect(engine.restore(INDEX, new Uint8Array([1, 2, 3, 4]))).rejects.toThrow()
    expect(engine.getStats(INDEX).savedBytes).toBe(savedBeforeRestore)
    await expectFiguresMatchTheFiles(engine, directory, INDEX, 'listedWithinTheFiles')

    await engine.restore(INDEX, snapshot)
    await expectFiguresMatchTheFiles(engine, directory, INDEX)
    await expectDocumentsOf(engine, INDEX, expected, [])
    const restoredBytes = engine.getStats(INDEX).savedBytes

    await engine.insert(INDEX, { title: 'after', body: bodyOf(DOCUMENTS + 1, BODY_LENGTH) }, 'after-restore')
    await expectFiguresMatchTheFiles(engine, directory, INDEX)
    await engine.shutdown()
    engine = await createNarsil(config)
    expect(engine.getStats(INDEX).savedBytes).toBe(restoredBytes)
    await expectFiguresMatchTheFiles(engine, directory, INDEX)
  }, 120_000)
})

describe('an index that saves nothing', () => {
  it('reports neither figure', async () => {
    const engine = await createNarsil({ workers: { enabled: false } })
    try {
      await engine.createIndex(INDEX, { schema: { title: 'string' } })
      await engine.insert(INDEX, { title: 'only in memory' }, 'one')
      const stats = engine.getStats(INDEX)
      expect(stats.savedBytes).toBeUndefined()
      expect(stats.logBytes).toBeUndefined()
      for (const partition of engine.getPartitionStats(INDEX)) {
        expect(partition.savedBytes).toBeUndefined()
        expect(partition.logBytes).toBeUndefined()
      }
    } finally {
      await engine.shutdown()
    }
  })
})

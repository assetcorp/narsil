import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'

const DOCUMENTS_BEFORE_EACH_SNAPSHOT = 70_000
const INSERTED_AT_ONCE = 20_000
const NEWEST_UPDATED = 2_000
const UPDATED_AT_ONCE = 250
const REMOVED_EVERY = 25
const SNAPSHOTS = 3
const NO_GRAPH_BELOW = 100_000_000
const PARK_MILLER_MULTIPLIER = 48_271
const PARK_MILLER_MODULUS = 2_147_483_647
const schema = { version: 'number' as const, embedding: 'vector[4]' as const }

function vectorOf(version: number, docNumber: number): number[] {
  return [version, docNumber, version + 0.5, -docNumber]
}

function idOf(docNumber: number): string {
  return `doc-${docNumber}`
}

interface WrittenHistory {
  documents: number
  applied: number
  version: number
  versions: Map<string, Set<number>>
  removed: Set<string>
}

async function insertFresh(engine: Narsil, history: WrittenHistory, count: number): Promise<void> {
  const first = history.documents
  history.documents += count
  const documents = Array.from({ length: count }, (_, offset) => {
    const docNumber = first + offset
    history.versions.set(idOf(docNumber), new Set([0]))
    return { id: idOf(docNumber), version: 0, embedding: vectorOf(0, docNumber) }
  })
  await engine.insertBatch('docs', documents)
  history.applied = Math.max(history.applied, first + count)
}

async function insertUntilSettled(engine: Narsil, history: WrittenHistory, settled: () => boolean) {
  while (!settled()) await insertFresh(engine, history, INSERTED_AT_ONCE)
}

async function updateUntilSettled(
  engine: Narsil,
  history: WrittenHistory,
  firstDuringSnapshot: number,
  settled: () => boolean,
) {
  let seed = firstDuringSnapshot
  while (!settled()) {
    history.version += 1
    const version = history.version
    const writes: Promise<void>[] = []
    const from = history.applied > firstDuringSnapshot ? firstDuringSnapshot : history.applied - NEWEST_UPDATED
    for (let n = 0; n < UPDATED_AT_ONCE; n++) {
      seed = (seed * PARK_MILLER_MULTIPLIER) % PARK_MILLER_MODULUS
      const docNumber = from + (seed % (history.applied - from))
      const docId = idOf(docNumber)
      if (history.removed.has(docId)) continue
      if (docNumber % REMOVED_EVERY === version % REMOVED_EVERY) {
        history.removed.add(docId)
        writes.push(engine.remove('docs', docId))
        continue
      }
      history.versions.get(docId)?.add(version)
      writes.push(engine.update('docs', docId, { version, embedding: vectorOf(version, docNumber) }))
    }
    await Promise.all(writes)
    await engine.compactVectors('docs')
  }
}

async function mismatchesIn(engine: Narsil, indexName: string, history: WrittenHistory): Promise<string[]> {
  const mismatches: string[] = []
  for (let docNumber = 0; docNumber < history.documents; docNumber++) {
    const docId = idOf(docNumber)
    const restored = await engine.get(indexName, docId)
    if (restored === undefined) continue
    const restoredVersion = restored.version
    const written = history.versions.get(docId)
    if (typeof restoredVersion !== 'number' || written === undefined || !written.has(restoredVersion)) {
      mismatches.push(`${indexName}: ${docId} holds version ${String(restoredVersion)}, which no write gave it`)
      continue
    }
    const expected = vectorOf(restoredVersion, docNumber)
    const embedding = restored.embedding
    const held = Array.isArray(embedding) || embedding instanceof Float32Array ? Array.from(embedding) : null
    if (held === null || held.length !== expected.length || held.some((value, i) => value !== expected[i])) {
      mismatches.push(`${indexName}: ${docId} holds version ${restoredVersion} with the vector ${JSON.stringify(held)}`)
    }
  }
  return mismatches
}

describe('a snapshot taken while documents change', () => {
  let dir: string
  let engine: Narsil | null = null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'narsil-archive-vectors-'))
  })

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
    await rm(dir, { recursive: true, force: true })
  })

  it('pairs every restored document with the vector it held at the same moment', async () => {
    engine = await createNarsil({ durability: { directory: dir }, workers: { enabled: false } })
    const live = engine
    await live.createIndex('docs', { schema, vectorPromotion: { threshold: NO_GRAPH_BELOW } })
    const history: WrittenHistory = { documents: 0, applied: 0, version: 0, versions: new Map(), removed: new Set() }

    const mismatches: string[] = []
    for (let snapshot = 0; snapshot < SNAPSHOTS; snapshot++) {
      await insertFresh(live, history, DOCUMENTS_BEFORE_EACH_SNAPSHOT)
      const firstDuringSnapshot = history.documents
      let snapshotSettled = false
      const settled = () => snapshotSettled
      const taken = live.snapshot('docs').finally(() => {
        snapshotSettled = true
      })
      const versionBefore = history.version
      await Promise.all([
        insertUntilSettled(live, history, settled),
        updateUntilSettled(live, history, firstDuringSnapshot, settled),
      ])
      expect(history.version).toBeGreaterThan(versionBefore)
      const copy = `copy-${snapshot}`
      await live.restore(copy, await taken)
      mismatches.push(...(await mismatchesIn(live, copy, history)))
      await live.dropIndex(copy)
    }
    expect(mismatches.length, mismatches.slice(0, 10).join('\n')).toBe(0)
  }, 300_000)
})

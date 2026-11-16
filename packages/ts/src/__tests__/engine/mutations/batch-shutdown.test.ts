import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../../errors'
import type { Narsil } from '../../../narsil'
import { createNarsil } from '../../../narsil'
import type { NarsilConfig } from '../../../types/config'
import type { BatchResult } from '../../../types/results'

const INDEX = 'harbours'
const DOCUMENTS_IN_BATCH = 5_000
const PARTITIONS = 8
const STORED_WORD = 'harbour'
const UPDATED_WORD = 'beacon'

const builtWorkerEntry = existsSync(new URL('../../../../dist/workers/entry.mjs', import.meta.url))

type BatchKind = 'insert by chunks' | 'insert by segments' | 'update' | 'remove'

const BATCH_KINDS: BatchKind[] = builtWorkerEntry
  ? ['insert by chunks', 'insert by segments', 'update', 'remove']
  : ['insert by chunks', 'update', 'remove']

function configOf(directory: string, kind: BatchKind): NarsilConfig {
  const workers =
    kind === 'insert by segments' ? { enabled: true, count: 2, promotionThreshold: 100 } : { enabled: false }
  return { durability: { directory, mode: 'sync' }, workers }
}

function idsOfBatch(): string[] {
  return Array.from({ length: DOCUMENTS_IN_BATCH }, (_, i) => `quay-${String(i).padStart(5, '0')}`)
}

function storedDocument(id: string): Record<string, unknown> {
  return { id, title: `${STORED_WORD} lighthouse ${id}` }
}

function updatedDocument(id: string): Record<string, unknown> {
  return { id, title: `${UPDATED_WORD} lighthouse ${id}` }
}

function startBatch(narsil: Narsil, kind: BatchKind, ids: string[]): Promise<BatchResult> {
  if (kind === 'update') {
    return narsil.updateBatch(
      INDEX,
      ids.map(docId => ({ docId, document: updatedDocument(docId) })),
    )
  }
  if (kind === 'remove') return narsil.removeBatch(INDEX, ids)
  return narsil.insertBatch(INDEX, ids.map(storedDocument))
}

async function batchHasWritten(narsil: Narsil, kind: BatchKind): Promise<boolean> {
  if (kind === 'update') {
    const found = await narsil.query(INDEX, { term: UPDATED_WORD, limit: 1 })
    return found.count > 0
  }
  const count = await narsil.countDocuments(INDEX)
  return kind === 'remove' ? count < DOCUMENTS_IN_BATCH : count > 0
}

async function shutDownPartway(narsil: Narsil, kind: BatchKind, batch: Promise<BatchResult>): Promise<boolean> {
  let settled = false
  batch.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  while (!settled) {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    if (settled) return false
    if (await batchHasWritten(narsil, kind)) {
      void narsil.shutdown()
      return true
    }
  }
  return false
}

async function searchedIds(narsil: Narsil, word: string): Promise<string[]> {
  const found = await narsil.query(INDEX, { term: word, limit: DOCUMENTS_IN_BATCH })
  return found.hits.map(hit => hit.id).sort()
}

describe('a batch write that the engine shuts down partway through', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-batch-shutdown-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it.each(
    BATCH_KINDS,
  )('reports every document of an interrupted %s batch once, as the restarted engine finds it', async kind => {
    const ids = idsOfBatch()
    const writer = await createNarsil(configOf(directory, kind))
    await writer.createIndex(INDEX, {
      schema: { title: 'string' },
      language: 'english',
      partitions: { maxPartitions: PARTITIONS },
    })
    if (kind === 'update' || kind === 'remove') {
      const seeded = await writer.insertBatch(INDEX, ids.map(storedDocument))
      expect(seeded.failed).toEqual([])
    }

    const batch = startBatch(writer, kind, ids)
    const stoppedPartway = await shutDownPartway(writer, kind, batch)
    const result = await batch
    await writer.shutdown()

    expect(stoppedPartway).toBe(true)
    const failedIds = result.failed.map(failure => failure.docId)
    const reported = [...result.succeeded, ...failedIds]
    expect(reported.length).toBe(DOCUMENTS_IN_BATCH)
    expect([...reported].sort()).toEqual([...ids].sort())
    expect(result.succeeded.length).toBeGreaterThan(0)
    expect(result.failed.length).toBeGreaterThan(0)
    expect(new Set(result.failed.map(failure => failure.error.code))).toEqual(new Set([ErrorCodes.INSTANCE_SHUT_DOWN]))

    const reader = await createNarsil({ durability: { directory, mode: 'sync' }, workers: { enabled: false } })
    try {
      const succeeded = [...result.succeeded].sort()
      const failed = [...failedIds].sort()
      if (kind === 'update') {
        expect(await searchedIds(reader, UPDATED_WORD)).toEqual(succeeded)
        expect(await searchedIds(reader, STORED_WORD)).toEqual(failed)
      } else if (kind === 'remove') {
        expect(await searchedIds(reader, STORED_WORD)).toEqual(failed)
      } else {
        expect(await searchedIds(reader, STORED_WORD)).toEqual(succeeded)
      }
    } finally {
      await reader.shutdown()
    }
  }, 120_000)
})

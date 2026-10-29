import { mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../../errors'
import { createNarsil } from '../../../index'
import type { Narsil } from '../../../narsil'

const INDEX = 'catalogue'
const SCHEMA = { title: 'string', price: 'number' } as const

const STORED: Record<string, { title: string; price: number }> = {
  'chair-1': { title: 'oak chair', price: 120 },
  'chair-2': { title: 'beech chair', price: 90 },
  'chair-3': { title: 'walnut chair', price: 210 },
  'chair-4': { title: 'pine chair', price: 45 },
  'chair-5': { title: 'ash chair', price: 75 },
}

async function codeOf(write: Promise<unknown>): Promise<unknown> {
  try {
    await write
    return 'stored'
  } catch (error) {
    return (error as { code?: unknown }).code ?? String(error)
  }
}

function codesOf(failed: ReadonlyArray<{ docId: string; error: unknown }>): Record<string, unknown> {
  return Object.fromEntries(failed.map(failure => [failure.docId, (failure.error as { code?: unknown }).code]))
}

describe('a durable engine whose log refuses writes before it applies them', () => {
  let directory: string
  let moved: string
  let engine: Narsil | undefined

  afterEach(async () => {
    await engine?.shutdown().catch(() => undefined)
    engine = undefined
    await rm(directory, { recursive: true, force: true })
    await rm(moved, { recursive: true, force: true })
  })

  it('reports the log failure for every remove and update, and leaves each document as it was', async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-failed-before-apply-'))
    moved = `${directory}-moved`
    engine = await createNarsil({ durability: { directory, mode: 'sync' }, workers: { enabled: false } })
    await engine.createIndex(INDEX, { schema: SCHEMA })
    const seeded = await engine.insertBatch(
      INDEX,
      Object.entries(STORED).map(([id, document]) => ({ id, ...document })),
    )
    expect(seeded.failed).toEqual([])

    await rename(directory, moved)
    expect(await codeOf(engine.insert(INDEX, { title: 'probe chair', price: 1 }, 'probe'))).toBe(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
    )

    const removed = await engine.removeBatch(INDEX, ['chair-1', 'chair-2', 'ghost'])
    expect(removed.succeeded).toEqual([])
    expect(codesOf(removed.failed)).toEqual({
      'chair-1': ErrorCodes.PERSISTENCE_SAVE_FAILED,
      'chair-2': ErrorCodes.PERSISTENCE_SAVE_FAILED,
      ghost: ErrorCodes.DOC_NOT_FOUND,
    })

    const updated = await engine.updateBatch(INDEX, [{ docId: 'chair-3', document: { title: 'teak chair', price: 1 } }])
    expect(updated.succeeded).toEqual([])
    expect(codesOf(updated.failed)).toEqual({ 'chair-3': ErrorCodes.PERSISTENCE_SAVE_FAILED })

    expect(await codeOf(engine.remove(INDEX, 'chair-4'))).toBe(ErrorCodes.PERSISTENCE_SAVE_FAILED)
    expect(await codeOf(engine.update(INDEX, 'chair-5', { title: 'elm chair', price: 2 }))).toBe(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
    )

    expect(await engine.has(INDEX, 'probe')).toBe(false)
    for (const [id, document] of Object.entries(STORED)) {
      expect(await engine.get(INDEX, id)).toMatchObject(document)
    }
    expect(await engine.countDocuments(INDEX)).toBe(Object.keys(STORED).length)
    const found = await engine.query(INDEX, { term: 'chair', limit: 20 })
    expect(found.hits.map(hit => hit.id).sort()).toEqual(Object.keys(STORED).sort())
    const replaced = await engine.query(INDEX, { term: 'teak elm', limit: 20 })
    expect(replaced.hits).toEqual([])
  })
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../../errors'
import { createNarsil } from '../../../index'
import type { Narsil } from '../../../narsil'

const INDEX = 'catalogue'
const SCHEMA = { title: 'string', price: 'number' } as const
const REFUSAL_BUDGET_MS = 2_000

function selfReferencingChair(): Record<string, unknown> {
  const chair: Record<string, unknown> = { title: 'looped chair', price: 10 }
  chair.self = chair
  return chair
}

async function codeOf(write: Promise<unknown>): Promise<unknown> {
  try {
    await write
    return 'stored'
  } catch (error) {
    return (error as { code?: unknown }).code ?? String(error)
  }
}

describe('a durable engine given a document that refers to itself', () => {
  let directory: string
  let engine: Narsil | undefined

  afterEach(async () => {
    await engine?.shutdown()
    engine = undefined
    await rm(directory, { recursive: true, force: true })
  })

  it('refuses the insert, the batch insert, and the update, and keeps serving and recovering every other write', async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-self-reference-'))
    engine = await createNarsil({ durability: { directory }, workers: { enabled: false } })
    await engine.createIndex(INDEX, { schema: SCHEMA })
    await engine.insert(INDEX, { title: 'oak chair', price: 120 }, 'chair-1')

    const startedAt = Date.now()
    expect(await codeOf(engine.insert(INDEX, selfReferencingChair(), 'looped-1'))).toBe(
      ErrorCodes.DOC_VALIDATION_FAILED,
    )
    const batch = await engine.insertBatch(INDEX, [{ id: 'looped-2', ...selfReferencingChair() }])
    expect(batch.succeeded).toEqual([])
    expect(batch.failed.map(failure => failure.docId)).toEqual(['looped-2'])
    expect(await codeOf(engine.update(INDEX, 'chair-1', selfReferencingChair()))).toBe(ErrorCodes.DOC_VALIDATION_FAILED)
    expect(Date.now() - startedAt).toBeLessThan(REFUSAL_BUDGET_MS)

    await engine.insert(INDEX, { title: 'beech chair', price: 90 }, 'chair-2')
    const expected = { 'chair-1': { title: 'oak chair', price: 120 }, 'chair-2': { title: 'beech chair', price: 90 } }

    for (const reopened of [false, true]) {
      if (reopened) {
        await engine.shutdown()
        engine = await createNarsil({ durability: { directory }, workers: { enabled: false } })
      }
      for (const absent of ['looped-1', 'looped-2']) expect(await engine.has(INDEX, absent)).toBe(false)
      for (const [id, document] of Object.entries(expected)) {
        expect(await engine.get(INDEX, id)).toMatchObject(document)
      }
      expect(await engine.countDocuments(INDEX)).toBe(2)
    }
  })
})

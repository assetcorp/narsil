import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerLanguage } from '../../../languages/registry'
import { yoruba } from '../../../languages/yoruba'
import { createNarsil, type Narsil } from '../../../narsil'
import type { QueryParams } from '../../../types/search'
import { type NativeOperation, observeFallbacks, setNativeSearchCoreEnabled } from '../../../vector/native/backend'
import { backendAvailable, searchThrough } from '../filtered-vectors/search-backend'
import { foldOracle, generatedDocuments, idsWithWord, YORUBA_WORDS } from './oracle'

searchThrough('native')

const INDEX = 'words'
const FROZEN_SEED = 31
const GROWING_SEED = 37
const FROZEN_DOCUMENTS = 400
const GROWING_DOCUMENTS = 160
const REMOVED_EVERY = 9
const EVERY_HIT = 2_000
const PARTIAL_NAMES = ['ayọkẹlẹ', 'ọkọ̀ ìwé', 'kékeré ilé', 'agba']

interface Answer {
  ids: string[]
  scores: Array<number | undefined>
  highlights: unknown[]
  count: number
}

function withNames<T extends { id: string; body: string }>(documents: readonly T[]) {
  return documents.map((document, at) => ({ ...document, name: PARTIAL_NAMES[at % PARTIAL_NAMES.length] }))
}

async function answerOf(narsil: Narsil, params: QueryParams, native: boolean): Promise<Answer> {
  setNativeSearchCoreEnabled(native)
  try {
    const result = await narsil.query(INDEX, { limit: EVERY_HIT, ...params })
    return {
      ids: result.hits.map(hit => hit.id),
      scores: result.hits.map(hit => hit.score),
      highlights: result.hits.map(hit => hit.highlights ?? null),
      count: result.count,
    }
  } finally {
    setNativeSearchCoreEnabled(true)
  }
}

async function expectBothBackends(narsil: Narsil, params: QueryParams): Promise<Answer> {
  const label = JSON.stringify(params)
  const typeScript = await answerOf(narsil, params, false)
  const core = await answerOf(narsil, params, true)
  expect(core.ids, label).toEqual(typeScript.ids)
  expect(core.count, label).toBe(typeScript.count)
  expect(core.highlights, label).toEqual(typeScript.highlights)
  for (let at = 0; at < core.scores.length; at++) {
    expect(Object.is(core.scores[at], typeScript.scores[at]), `${label} rank ${at}`).toBe(true)
  }
  return core
}

describe.skipIf(!backendAvailable('native'))('folded matching through the C core and through TypeScript', () => {
  const fallbacks: NativeOperation[] = []
  const frozen = withNames(generatedDocuments(FROZEN_DOCUMENTS, YORUBA_WORDS, FROZEN_SEED))
  const growing = withNames(
    generatedDocuments(GROWING_DOCUMENTS, YORUBA_WORDS, GROWING_SEED).map(document => ({
      ...document,
      id: `later-${document.id}`,
    })),
  )
  const removed = frozen.filter((_, at) => at % REMOVED_EVERY === 0).map(document => document.id)
  const kept = [...frozen.filter(document => !removed.includes(document.id)), ...growing]
  let directory: string
  let narsil: Narsil

  beforeAll(async () => {
    observeFallbacks(operation => fallbacks.push(operation))
    registerLanguage(yoruba)
    directory = await mkdtemp(join(tmpdir(), 'narsil-folded-backends-'))
    const created = await createNarsil({ durability: { directory }, workers: { enabled: false } })
    await created.createIndex(INDEX, {
      schema: { body: 'string', name: 'string:partial' },
      language: 'yoruba',
      partitions: { maxPartitions: 2 },
    })
    await created.insertBatch(INDEX, frozen)
    await created.rebalance(INDEX, 2)
    await created.checkpoint(INDEX)
    await created.shutdown()
    narsil = await createNarsil({ durability: { directory }, workers: { enabled: false } })
    await narsil.insertBatch(INDEX, growing)
    await narsil.removeBatch(INDEX, removed)
  })

  afterAll(async () => {
    observeFallbacks(null)
    await narsil.shutdown()
    await rm(directory, { recursive: true, force: true })
    expect(fallbacks).toEqual([])
  })

  it('finds the same documents with the same scores as the oracle and as each other', async () => {
    for (const query of ['oko', 'ile', 'kekere', 'iwe']) {
      const answer = await expectBothBackends(narsil, { term: query, fields: ['body'] })
      expect([...answer.ids].sort(), query).toEqual(idsWithWord(kept, word => foldOracle(word) === query))
    }
    await expectBothBackends(narsil, { term: 'ọkọ̀ ìlú' })
    await expectBothBackends(narsil, { term: 'okx kekera', tolerance: 1 })
    await expectBothBackends(narsil, { term: 'oko ile', termMatch: 'all', tolerance: 1 })
  })

  it('completes, matches phrases, and adds partial words in the same way', async () => {
    await expectBothBackends(narsil, { term: 'ok', prefix: true })
    await expectBothBackends(narsil, { term: 'ile ke', prefix: true })
    await expectBothBackends(narsil, { term: '"oko kekere"' })
    await expectBothBackends(narsil, { term: '"kekere ile"' })
    await expectBothBackends(narsil, { term: 'oke', partialWords: true })
    await expectBothBackends(narsil, { term: 'oko ile', partialWords: true, tolerance: 1 })
  })

  it('marks the same spans in each highlighted field', async () => {
    const highlight = { fields: ['body', 'name'] }
    await expectBothBackends(narsil, { term: 'oko ile ore', highlight })
    await expectBothBackends(narsil, { term: 'ke', prefix: true, highlight })
    await expectBothBackends(narsil, { term: 'oke', partialWords: true, highlight })
  })
})

import { existsSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerLanguage } from '../../../languages/registry'
import { yoruba } from '../../../languages/yoruba'
import { createNarsil, type Narsil } from '../../../narsil'
import { DEFAULT_FUZZY_PREFIX_LENGTH } from '../../../search/constants'
import type { QueryParams } from '../../../types/search'
import {
  editDistance,
  foldOracle,
  generatedDocuments,
  idsWithWord,
  sharesLeadingPoints,
  wordSpans,
  YORUBA_QUERY_WORDS,
  YORUBA_WORDS,
} from './oracle'

const distIndex = new URL('../../../../dist/index.mjs', import.meta.url)
const distYoruba = new URL('../../../../dist/languages/yoruba.mjs', import.meta.url)
const built = existsSync(new URL('../../../../dist/workers/entry.mjs', import.meta.url))
const registersYoruba = `data:text/javascript,${encodeURIComponent(
  `import { registerLanguage } from '${distIndex.href}'\nimport { yoruba } from '${distYoruba.href}'\nregisterLanguage(yoruba)\n`,
)}`
const CORPUS_SIZE = 1_400
const CORPUS_SEED = 23
const EVERY_HIT = 2_000
const COPY_WAIT_MS = 30_000
const COPY_POLL_MS = 25
const documents = generatedDocuments(CORPUS_SIZE, YORUBA_WORDS, CORPUS_SEED)

async function scaledOut(narsil: Narsil): Promise<boolean> {
  const stats = await narsil.getMemoryStats()
  return stats.workerCopies.some(copy => copy.indexName === 'words' && copy.scaledOut)
}

async function waitForCopies(narsil: Narsil): Promise<void> {
  const start = Date.now()
  while (!(await scaledOut(narsil))) {
    if (Date.now() - start > COPY_WAIT_MS) throw new Error('The worker copies never loaded')
    await new Promise(resolve => setTimeout(resolve, COPY_POLL_MS))
  }
}

async function hitIds(narsil: Narsil, params: QueryParams): Promise<string[]> {
  return (await narsil.query('words', { limit: EVERY_HIT, ...params })).hits.map(hit => hit.id).sort()
}

describe.skipIf(!built)('folded matching on worker copies', () => {
  let narsil: Narsil

  beforeAll(async () => {
    registerLanguage(yoruba)
    narsil = await createNarsil({ workers: { bootstrapModule: registersYoruba, mainCopyQueries: 'none' } })
    await narsil.createIndex('words', {
      schema: { body: 'string' },
      language: 'yoruba',
      partitions: { maxPartitions: 2 },
    })
    await narsil.insertBatch('words', documents)
    await waitForCopies(narsil)
  })

  afterAll(async () => {
    await narsil.shutdown()
  })

  it('answers plain, typo, and half-typed queries from the copies as the oracle folds them', async () => {
    for (const query of YORUBA_QUERY_WORDS) {
      expect(await hitIds(narsil, { term: query }), query).toEqual(
        idsWithWord(documents, word => foldOracle(word) === query),
      )
      const typo = `${query.slice(0, -1)}x`
      const accepts = (candidate: string): boolean =>
        sharesLeadingPoints(candidate, typo, DEFAULT_FUZZY_PREFIX_LENGTH) && editDistance(candidate, typo) <= 1
      expect(await hitIds(narsil, { term: typo, tolerance: 1 }), typo).toEqual(
        idsWithWord(documents, word => accepts(word) || accepts(foldOracle(word))),
      )
      const typed = query.slice(0, 2)
      expect(await hitIds(narsil, { term: typed, prefix: true }), typed).toEqual(
        idsWithWord(documents, word => word.startsWith(typed) || foldOracle(word).startsWith(typed)),
      )
    }
  })

  it('highlights the marked words of each hit from the copies', async () => {
    const result = await narsil.query('words', { term: 'oko', limit: EVERY_HIT, highlight: { fields: ['body'] } })
    expect(result.hits.length).toBeGreaterThan(0)
    for (const hit of result.hits) {
      const body = documents.find(document => document.id === hit.id)?.body ?? ''
      expect(hit.highlights?.body?.positions, hit.id).toEqual(wordSpans(body, word => foldOracle(word) === 'oko'))
    }
  })

  it('stops folding on the copies once foldMarks turns off, and starts again once it turns on', async () => {
    await narsil.changeAnalysis('words', { foldMarks: false })
    for (const query of YORUBA_QUERY_WORDS) {
      expect(await hitIds(narsil, { term: query }), query).toEqual(idsWithWord(documents, word => word === query))
    }
    await narsil.changeAnalysis('words', { foldMarks: true })
    for (const query of YORUBA_QUERY_WORDS) {
      expect(await hitIds(narsil, { term: query }), query).toEqual(
        idsWithWord(documents, word => foldOracle(word) === query),
      )
    }
  })
})

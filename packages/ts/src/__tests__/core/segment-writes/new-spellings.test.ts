import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import { LANGUAGE_NAME, registerWorkshopLanguage } from '../../e2e/partial-words/corpus'
import { seededRandom } from '../../filters/pattern/random-corpus'
import { EVERY_MATCH, KEYWORD_BACKENDS, scoreThrough } from '../keyword-score/ranking'

const INDEX = 'new-spellings'
const DOCUMENT_COUNT = 4
const SPELLINGS_PER_DOCUMENT = 300
const WRITE_PLAN_START_CAPACITY = 64
const SPELLING_LETTERS = 'abcdefghijklmnopqrtuvwxyz'
const SPELLING_LENGTH = 5
const RUN_LENGTH = 3
const SPELLING_SEED = 20261110

type Catalogue = {
  id: string
  title: string
}

function runsOf(spelling: string): string[] {
  const runs: string[] = []
  for (let at = 0; at + RUN_LENGTH <= spelling.length; at++) runs.push(spelling.slice(at, at + RUN_LENGTH))
  return runs
}

function spellingsSharingNoRun(count: number): string[] {
  const random = seededRandom(SPELLING_SEED)
  const usedRuns = new Set<string>()
  const spellings: string[] = []
  while (spellings.length < count) {
    let spelling = ''
    for (let at = 0; at < SPELLING_LENGTH; at++)
      spelling += SPELLING_LETTERS[Math.floor(random() * SPELLING_LETTERS.length)]
    const runs = runsOf(spelling)
    if (new Set(runs).size < runs.length || runs.some(run => usedRuns.has(run))) continue
    for (const run of runs) usedRuns.add(run)
    spellings.push(spelling)
  }
  return spellings
}

function catalogue(): Catalogue[] {
  const spellings = spellingsSharingNoRun(DOCUMENT_COUNT * SPELLINGS_PER_DOCUMENT)
  return Array.from({ length: DOCUMENT_COUNT }, (_, document) => ({
    id: `catalogue-${document}`,
    title: spellings.slice(document * SPELLINGS_PER_DOCUMENT, (document + 1) * SPELLINGS_PER_DOCUMENT).join(' '),
  }))
}

function middleRunOf(spelling: string): string {
  return spelling.slice(1, 1 + RUN_LENGTH)
}

function holdersOf(documents: readonly Catalogue[], part: string): string[] {
  return documents
    .filter(document => document.title.split(' ').some(word => word.length > part.length && word.includes(part)))
    .map(document => document.id)
    .sort()
}

for (const backend of KEYWORD_BACKENDS) {
  describe(`one batch that adds more new spellings than a write plan starts with, through ${backend.name}`, () => {
    scoreThrough(backend)
    const documents = catalogue()
    let narsil: Narsil | undefined

    beforeAll(async () => {
      registerWorkshopLanguage()
      narsil = await createNarsil({ workers: { enabled: false } })
      await narsil.createIndex(INDEX, { schema: { title: 'string:partial' }, language: LANGUAGE_NAME })
    })

    afterAll(async () => {
      await narsil?.shutdown()
    })

    it('inserts every document and finds each spelling after the first 64 by a part inside it', async () => {
      if (narsil === undefined) throw new Error('the engine did not start')
      const inserted = await narsil.insertBatch(INDEX, documents)
      expect(inserted.failed).toEqual([])
      expect(await narsil.countDocuments(INDEX)).toBe(DOCUMENT_COUNT)

      let checked = 0
      for (const document of documents) {
        for (const spelling of document.title.split(' ').slice(WRITE_PLAN_START_CAPACITY)) {
          const part = middleRunOf(spelling)
          const expected = holdersOf(documents, part)
          expect(expected, part).toEqual([document.id])
          const result = await narsil.query(INDEX, { term: part, partialWords: true, limit: EVERY_MATCH })
          expect(result.hits.map(hit => hit.id).sort(), part).toEqual(expected)
          checked++
        }
      }
      expect(checked).toBe(DOCUMENT_COUNT * (SPELLINGS_PER_DOCUMENT - WRITE_PLAN_START_CAPACITY))
    }, 60_000)
  })
}

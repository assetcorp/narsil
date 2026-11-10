import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import { EVERY_MATCH, KEYWORD_BACKENDS, scoreThrough } from './ranking'

const INDEX = 'retired-postings'
const CORPUS_SIZE = 300
const FIRST_REMOVAL_STRIDE = 5
const QUOKKA_STRIDE = 3
const DINGO_STRIDE = 50
const QUERIED_WORDS = ['wombat', 'quokka', 'dingo', 'numbat'] as const

type Paper = {
  id: string
  title: string
  body: string
}

function paper(at: number): Paper {
  const words = ['wombat']
  if (at % QUOKKA_STRIDE === 0) words.push('quokka')
  if (at % DINGO_STRIDE === 0) words.push('dingo')
  return { id: `doc-${at}`, title: at === 1 ? 'dingo' : 'bilby', body: words.join(' ') }
}

function holders(papers: ReadonlyMap<string, Paper>, word: string): string[] {
  const found: string[] = []
  for (const { id, title, body } of papers.values()) if (`${title} ${body}`.split(' ').includes(word)) found.push(id)
  return found.sort()
}

async function expectMatchesOracle(narsil: Narsil, papers: ReadonlyMap<string, Paper>, stage: string): Promise<void> {
  for (const word of QUERIED_WORDS) {
    const result = await narsil.query(INDEX, { term: word, limit: EVERY_MATCH })
    const expected = holders(papers, word)
    expect(result.hits.map(hit => hit.id).sort(), `${stage}: ${word}`).toEqual(expected)
    expect(result.count, `${stage}: ${word}`).toBe(expected.length)
  }
}

async function removeAll(narsil: Narsil, papers: Map<string, Paper>, ids: string[]): Promise<void> {
  const outcome = await narsil.removeBatch(INDEX, ids)
  expect(outcome.failed).toEqual([])
  for (const id of ids) papers.delete(id)
}

for (const backend of KEYWORD_BACKENDS) {
  describe(`removed documents whose postings stay below the compaction threshold, through ${backend.name}`, () => {
    scoreThrough(backend)
    let narsil: Narsil
    const papers = new Map<string, Paper>()

    beforeAll(async () => {
      narsil = await createNarsil({ workers: { enabled: false } })
      await narsil.createIndex(INDEX, { schema: { title: 'string', body: 'string' } })
      const corpus = Array.from({ length: CORPUS_SIZE }, (_, at) => paper(at))
      const inserted = await narsil.insertBatch(INDEX, corpus)
      expect(inserted.failed).toEqual([])
      for (const entry of corpus) papers.set(entry.id, entry)
    })

    afterAll(async () => {
      await narsil.shutdown()
    })

    it('never returns a document that a batch removed, before and after further writes', async () => {
      await expectMatchesOracle(narsil, papers, 'before removal')
      const firstBatch = [...papers.keys()].filter((_, at) => at % FIRST_REMOVAL_STRIDE === 0)
      await removeAll(narsil, papers, firstBatch)
      await expectMatchesOracle(narsil, papers, 'after a removal batch that leaves a fifth of each list dead')

      const reinserted = { id: 'doc-0', title: 'numbat', body: 'quokka dingo' }
      const fresh = { id: 'doc-fresh', title: 'numbat', body: 'wombat' }
      await narsil.insert(INDEX, reinserted, reinserted.id)
      await narsil.insert(INDEX, fresh, fresh.id)
      papers.set(reinserted.id, reinserted)
      papers.set(fresh.id, fresh)
      await expectMatchesOracle(narsil, papers, 'after reinserting a removed id and adding a new document')

      await narsil.remove(INDEX, 'doc-3')
      papers.delete('doc-3')
      await expectMatchesOracle(narsil, papers, 'after one removal outside a batch')

      const secondBatch = [...papers.keys()].filter(id => {
        const at = Number(id.slice('doc-'.length))
        return Number.isInteger(at) && at % FIRST_REMOVAL_STRIDE === 1
      })
      await removeAll(narsil, papers, secondBatch)
      await expectMatchesOracle(narsil, papers, 'after a second batch pushes the lists past the threshold')
    })
  })
}

import { existsSync } from 'node:fs'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import { scaledOut, waitFor } from '../../server/helpers'
import { DASHES_TOKENIZER, registerFixtures, seededRandom } from './oracle'

const WORKERS_BUILT = existsSync(new URL('../../../../dist/workers/entry.mjs', import.meta.url))
const INDEX = 'shore'
const OTHER_INDEX = 'harbor'
const DOCUMENTS = 6_000
const HITS_PAGE = 10_000
const WORDS = ['sea', 'wall', 'river', 'harbor', 'cliff']
const REMOVED_WORD = 'river'
const SEARCHES_AFTER_THE_SWITCH = 12
const SWITCH_SPREAD_MS = 2_000

function titlesOf(seed: number, words: string[]): Map<string, string> {
  const random = seededRandom(seed)
  const titles = new Map<string, string>()
  for (let i = 0; i < DOCUMENTS; i++) {
    titles.set(`doc-${i}`, Array.from({ length: 6 }, () => words[Math.floor(random() * words.length)]).join(' '))
  }
  return titles
}

function idsHolding(titles: ReadonlyMap<string, string>, probe: string, tokensOf: (title: string) => string[]) {
  const found: string[] = []
  for (const [id, title] of titles) if (tokensOf(title).includes(probe)) found.push(id)
  return found.sort()
}

const onSpaces = (title: string) => title.split(' ')
const onSpacesAndDashes = (title: string) => title.split(/[ -]/)

describe('worker copies during an analysis change', () => {
  let engine: Narsil | null = null

  beforeAll(() => {
    registerFixtures()
  })

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
  })

  async function loaded(titles: Map<string, string>, mainCopyQueries: 'none' | undefined): Promise<Narsil> {
    const running = await createNarsil({
      workers: { enabled: true, count: 2, promotionThreshold: 100, ...(mainCopyQueries ? { mainCopyQueries } : {}) },
    })
    engine = running
    await running.createIndex(INDEX, { schema: { title: 'string' }, language: 'english' })
    const batch = [...titles].map(([id, title]) => ({ id, title }))
    expect((await running.insertBatch(INDEX, batch)).failed).toEqual([])
    await waitFor(() => scaledOut(running, INDEX), 30_000)
    return running
  }

  async function search(running: Narsil, term: string): Promise<string[]> {
    const page = await running.query(INDEX, { term, limit: HITS_PAGE })
    return page.hits.map(hit => hit.id).sort()
  }

  it.skipIf(!WORKERS_BUILT)(
    'answers every search from the copies under one set of settings, before and after the switch',
    async () => {
      const titles = titlesOf(47, WORDS)
      const running = await loaded(titles, 'none')
      const everyWord = new Map(WORDS.map(word => [word, idsHolding(titles, word, onSpaces)]))

      let finished = false
      const change = running.changeAnalysis(INDEX, { stopWords: [REMOVED_WORD] }).finally(() => {
        finished = true
      })
      let searches = 0
      while (!finished) {
        const word = WORDS[searches % WORDS.length]
        const hits = await search(running, word)
        const allowed = word === REMOVED_WORD ? [everyWord.get(word), []] : [everyWord.get(word)]
        expect(allowed).toContainEqual(hits)
        searches++
        await new Promise(resolve => setImmediate(resolve))
      }
      await change
      expect(searches).toBeGreaterThan(0)

      for (let i = 0; i < SEARCHES_AFTER_THE_SWITCH; i++) {
        const word = WORDS[i % WORDS.length]
        const expected = word === REMOVED_WORD ? [] : everyWord.get(word)
        expect({ word, hits: await search(running, word) }).toEqual({ word, hits: expected })
      }

      await running.insert(INDEX, { title: `${REMOVED_WORD} sea` }, 'late')
      titles.set('late', `${REMOVED_WORD} sea`)
      const seaWithLate = idsHolding(titles, 'sea', onSpaces)
      await waitFor(async () => JSON.stringify(await search(running, 'sea')) === JSON.stringify(seaWithLate))
      for (let i = 0; i < SEARCHES_AFTER_THE_SWITCH; i++) {
        expect(await search(running, 'sea')).toEqual(seaWithLate)
        expect(await search(running, REMOVED_WORD)).toEqual([])
      }
    },
    90_000,
  )

  it.skipIf(!WORKERS_BUILT)(
    'answers from the main copy under a registered tokeniser that no worker bootstrap module registers',
    async () => {
      const titles = titlesOf(53, ['sea-wall', 'sea', 'wall', 'cliff'])
      const running = await loaded(titles, undefined)
      const oldAnswer = idsHolding(titles, 'sea', onSpaces)
      const newAnswer = idsHolding(titles, 'sea', onSpacesAndDashes)
      expect(oldAnswer).not.toEqual(newAnswer)

      await running.changeAnalysis(INDEX, { tokenizer: DASHES_TOKENIZER })
      const started = Date.now()
      while (Date.now() - started < SWITCH_SPREAD_MS) {
        expect(await search(running, 'sea')).toEqual(newAnswer)
      }

      await running.createIndex(OTHER_INDEX, { schema: { title: 'string' }, language: 'english' })
      const otherBatch = [...titles].map(([id, title]) => ({ id, title }))
      expect((await running.insertBatch(OTHER_INDEX, otherBatch)).failed).toEqual([])
      await waitFor(() => scaledOut(running, OTHER_INDEX), 30_000)
    },
    90_000,
  )
})

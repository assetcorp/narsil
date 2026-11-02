import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import type { Narsil } from '../../../types/engine'
import type { IndexConfig } from '../../../types/schema'
import { seededRandom } from './oracle'

const INDEX = 'articles'
const STEMMED_WORDS = ['running', 'jumping', 'walked', 'talking'] as const
const WORD_REMOVED_ENTIRELY = 'running'
const DOCUMENTS = 400

const CONFIG: IndexConfig = {
  schema: { body: 'string' },
  language: 'english',
  textStorage: 'disk',
  surfaceForms: true,
}

describe('a removal that an index with its text on disk replays from its log', () => {
  let root: string
  let engine: Narsil

  async function open(): Promise<void> {
    engine = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
  }

  async function expectAnswers(oracle: ReadonlyMap<string, string>): Promise<void> {
    expect(await engine.countDocuments(INDEX)).toBe(oracle.size)
    for (const word of STEMMED_WORDS) {
      const holders = [...oracle].filter(([, body]) => body.split(' ').includes(word)).map(([id]) => id)
      const page = await engine.query(INDEX, { term: word, limit: DOCUMENTS })
      expect(page.hits.map(hit => hit.id).sort()).toEqual(holders.sort())
      const suggested = await engine.suggest(INDEX, { prefix: word.slice(0, -1) })
      expect(suggested.terms.map(term => term.term).includes(word), word).toBe(holders.length > 0)
    }
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-disk-removals-'))
    await open()
    await engine.createIndex(INDEX, CONFIG)
  })

  afterEach(async () => {
    await engine.shutdown()
    await rm(root, { recursive: true, force: true })
  })

  it('suggests and finds only what the remaining documents hold, through restarts and a merge', async () => {
    const random = seededRandom(9502)
    const oracle = new Map<string, string>()
    const word = (): string => STEMMED_WORDS[Math.floor(random() * STEMMED_WORDS.length)]
    for (let at = 0; at < DOCUMENTS; at++) {
      const body = `${word()} ${word()}`
      await engine.insert(INDEX, { body }, `article-${at}`)
      oracle.set(`article-${at}`, body)
    }
    await engine.checkpoint(INDEX)
    await expectAnswers(oracle)

    for (const [id, body] of [...oracle]) {
      if (!body.split(' ').includes(WORD_REMOVED_ENTIRELY)) continue
      await engine.remove(INDEX, id)
      oracle.delete(id)
    }
    await engine.shutdown()
    await open()
    await expectAnswers(oracle)

    await engine.shutdown()
    await open()
    await engine.checkpoint(INDEX)
    await engine.shutdown()
    await open()
    await expectAnswers(oracle)
  }, 60_000)
})

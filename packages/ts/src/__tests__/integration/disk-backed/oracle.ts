import { expect } from 'vitest'
import type { Narsil } from '../../../types/engine'

export type ArticleDocument = {
  title: string
  body: string
  year: number
}

export const VOCABULARY = [
  'amber',
  'basil',
  'cedar',
  'dahlia',
  'ember',
  'fennel',
  'garnet',
  'hazel',
  'indigo',
  'jasmin',
  'kestrel',
  'lantern',
  'mango',
  'nutmeg',
  'orchid',
  'pewter',
] as const

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

export function randomArticle(random: () => number): ArticleDocument {
  const word = (): string => VOCABULARY[Math.floor(random() * VOCABULARY.length)]
  return {
    title: `${word()} ${word()}`,
    body: `${word()} ${word()} ${word()} ${word()}`,
    year: 1990 + Math.floor(random() * 30),
  }
}

export class ArticleOracle {
  readonly documents = new Map<string, ArticleDocument>()

  set(id: string, document: ArticleDocument): void {
    this.documents.set(id, document)
  }

  delete(id: string): void {
    this.documents.delete(id)
  }

  idsHolding(word: string): string[] {
    const ids: string[] = []
    for (const [id, document] of this.documents) {
      if (`${document.title} ${document.body}`.split(' ').includes(word)) ids.push(id)
    }
    return ids.sort()
  }

  idsFrom(year: number): string[] {
    const ids: string[] = []
    for (const [id, document] of this.documents) {
      if (document.year >= year) ids.push(id)
    }
    return ids.sort()
  }
}

function sortedIds(hits: ReadonlyArray<{ id: string }>): string[] {
  return hits.map(hit => hit.id).sort()
}

export async function expectSearchesMatchOracle(
  engine: Narsil,
  indexName: string,
  oracle: ArticleOracle,
): Promise<void> {
  const limit = oracle.documents.size + 10
  expect(await engine.countDocuments(indexName)).toBe(oracle.documents.size)
  for (const word of VOCABULARY) {
    const exact = await engine.query(indexName, { term: word, limit })
    expect(sortedIds(exact.hits)).toEqual(oracle.idsHolding(word))
    const prefix = await engine.query(indexName, { term: word.slice(0, 4), prefix: true, limit })
    expect(sortedIds(prefix.hits)).toEqual(oracle.idsHolding(word))
    const typo = await engine.query(indexName, { term: `${word}q`, tolerance: 1, limit })
    expect(sortedIds(typo.hits)).toEqual(oracle.idsHolding(word))
    const sorted = await engine.query(indexName, { term: word, sort: { year: 'asc' }, limit })
    const years = sorted.hits.map(hit => oracle.documents.get(hit.id)?.year ?? Number.NaN)
    expect(years).toEqual([...years].sort((a, b) => a - b))
    const filtered = await engine.query(indexName, { term: word, filters: { fields: { year: { gte: 2005 } } }, limit })
    const fromThatYear = new Set(oracle.idsFrom(2005))
    expect(sortedIds(filtered.hits)).toEqual(oracle.idsHolding(word).filter(id => fromThatYear.has(id)))
  }
}

export async function expectEngineMatchesOracle(
  engine: Narsil,
  indexName: string,
  oracle: ArticleOracle,
): Promise<void> {
  await expectSearchesMatchOracle(engine, indexName, oracle)
  for (const [id, document] of [...oracle.documents].slice(0, 25)) {
    expect(await engine.get(indexName, id)).toEqual(document)
  }
}

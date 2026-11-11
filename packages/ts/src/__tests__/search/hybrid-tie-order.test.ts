import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'

const INDEX = 'shelves'
const RANK_CONSTANT = 60
const WORDS_PER_TITLE = 8
const QUERY_VECTOR = [1, 0]

const IDS_BY_TEXT_RANK = [
  '\u{1F600}-ember',
  'doc-b',
  'zeta',
  'same-prefix-2',
  'same-prefix-10',
  'alpha',
  'doc-a',
  'ｚ-ember',
]

function shelf(textRank: number): { id: string; title: string; embedding: number[] } {
  const matches = IDS_BY_TEXT_RANK.length - textRank
  const title = [
    ...Array.from({ length: matches }, () => 'amber'),
    ...Array.from({ length: WORDS_PER_TITLE - matches }, () => 'filler'),
  ].join(' ')
  const angle = (IDS_BY_TEXT_RANK.length - 1 - textRank) * 0.1
  return { id: IDS_BY_TEXT_RANK[textRank], title, embedding: [Math.cos(angle), Math.sin(angle)] }
}

function codePointOrder(left: string, right: string): number {
  const leftPoints = Array.from(left, character => character.codePointAt(0) ?? 0)
  const rightPoints = Array.from(right, character => character.codePointAt(0) ?? 0)
  for (let at = 0; at < Math.min(leftPoints.length, rightPoints.length); at++) {
    if (leftPoints[at] !== rightPoints[at]) return leftPoints[at] - rightPoints[at]
  }
  return leftPoints.length - rightPoints.length
}

function reciprocalRanks(lists: readonly string[][]): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>()
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      scores.set(list[rank], (scores.get(list[rank]) ?? 0) + 1 / (RANK_CONSTANT + rank + 1))
    }
  }
  return [...scores]
    .map(([id, score]) => ({ id, score }))
    .sort((left, right) => right.score - left.score || codePointOrder(left.id, right.id))
}

describe('hybrid fusion of tied scores', () => {
  let narsil: Narsil

  beforeAll(async () => {
    narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex(INDEX, { schema: { title: 'string', embedding: 'vector[2]' } })
    await narsil.insertBatch(
      INDEX,
      IDS_BY_TEXT_RANK.map((_, rank) => shelf(rank)),
    )
  })

  afterAll(async () => {
    await narsil.shutdown()
  })

  it('orders documents whose fused scores tie by the code points of their IDs', async () => {
    const depth = IDS_BY_TEXT_RANK.length
    const text = await narsil.query(INDEX, { term: 'amber', limit: depth, document: false })
    const vector = await narsil.query(INDEX, {
      vector: { field: 'embedding', value: QUERY_VECTOR },
      limit: depth,
      document: false,
    })
    const expected = reciprocalRanks([text.hits.map(hit => hit.id), vector.hits.map(hit => hit.id)])
    const tiedPairs = expected.filter((entry, at) => at > 0 && entry.score === expected[at - 1].score)
    expect(tiedPairs.length).toBeGreaterThanOrEqual(3)

    const fused = await narsil.query(INDEX, {
      term: 'amber',
      vector: { field: 'embedding', value: QUERY_VECTOR },
      hybrid: { strategy: 'rrf', k: RANK_CONSTANT, depth },
      limit: depth,
      document: false,
    })

    expect(fused.hits.map(hit => hit.id)).toEqual(expected.map(entry => entry.id))
    for (let at = 0; at < fused.hits.length; at++) expect(fused.hits[at].score).toBeCloseTo(expected[at].score, 12)
  })

  it('orders a linear fusion where every document ties by the code points of their IDs', async () => {
    const identical = 'identical'
    const ids = Array.from({ length: 40 }, (_, at) =>
      at % 3 === 0 ? `\u{1F600}-${at}` : at % 3 === 1 ? `ｚ-${at}` : `same-prefix-${at}`,
    )
    await narsil.createIndex(identical, { schema: { title: 'string', embedding: 'vector[2]' } })
    await narsil.insertBatch(
      identical,
      ids.map(id => ({ id, title: 'amber filler', embedding: [1, 0] })),
    )

    const fused = await narsil.query(identical, {
      term: 'amber',
      vector: { field: 'embedding', value: QUERY_VECTOR },
      hybrid: { strategy: 'linear', alpha: 0.5, depth: ids.length },
      limit: ids.length,
      document: false,
    })

    expect(fused.hits.map(hit => hit.id)).toEqual([...ids].sort(codePointOrder))
    for (const hit of fused.hits) expect(hit.score).toBe(fused.hits[0].score)
  })
})

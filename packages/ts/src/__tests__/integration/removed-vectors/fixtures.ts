import { afterAll, beforeAll, expect } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import type { NarsilConfig } from '../../../types/config'
import type { AnyDocument, IndexConfig, VectorQuantizationMode } from '../../../types/schema'
import { loadNativeCore } from '../../../vector/native/loader'
import { binaryBuilt, pointAtTheHostBinary, seededRandom } from '../../vector/native/fixtures'

const DIMENSION = 32
const DOCUMENT_COUNT = 300
const WORKER_DOCUMENT_COUNT = 1200
const RING_DOCUMENT_COUNT = 3000
const KEPT_EVERY = 10
export const QUERY_COUNT = 20
const RING_QUERY_COUNT = 50
const K = 10
export const FAR_AWAY_OFFSET = 20
const RING_WIDTH = 10
export const SETTLE_DEADLINE_MS = 20_000

export function indexConfigOf(quantization: VectorQuantizationMode): IndexConfig {
  return {
    schema: { embedding: `vector[${DIMENSION}]` },
    vectorPromotion: {
      threshold: 50,
      quantization,
      hnswConfig: { m: 8, efConstruction: 60, metric: 'euclidean' },
    },
  }
}

export const indexConfig = indexConfigOf('none')

export type Paper = AnyDocument & {
  id: string
  embedding: number[]
}

export interface Corpus {
  documents: Paper[]
  kept: Paper[]
  changed: Paper[]
  reembedded: Paper[]
}

const random = seededRandom(20261026)

function randomVector(): number[] {
  return Array.from({ length: DIMENSION }, () => random() * 2 - 1)
}

function corpusOf(count: number): Corpus {
  const documents: Paper[] = Array.from({ length: count }, (_, i) => ({
    id: `paper-${String(i).padStart(4, '0')}`,
    embedding: randomVector(),
  }))
  const changed = documents.filter((_, i) => i % KEPT_EVERY !== 0)
  return {
    documents,
    kept: documents.filter((_, i) => i % KEPT_EVERY === 0),
    changed,
    reembedded: changed.map(document => ({
      id: document.id,
      embedding: document.embedding.map(value => value + FAR_AWAY_OFFSET),
    })),
  }
}

export const small = corpusOf(DOCUMENT_COUNT)
export const large = corpusOf(WORKER_DOCUMENT_COUNT)
export const queries = Array.from({ length: QUERY_COUNT }, randomVector)
export const queriesNearTheReembedded = queries.map(query => query.map(value => value + FAR_AWAY_OFFSET))
const ringDocuments = corpusOf(RING_DOCUMENT_COUNT).documents
const ringQueries = Array.from({ length: RING_QUERY_COUNT }, randomVector)

function ranked(current: Paper[], query: number[]): string[] {
  const scored = current.map(document => {
    let squared = 0
    for (let i = 0; i < DIMENSION; i++) squared += (query[i] - document.embedding[i]) ** 2
    return { id: document.id, squared }
  })
  scored.sort((a, b) => a.squared - b.squared)
  return scored.map(entry => entry.id)
}

function nearest(current: Paper[], query: number[]): string[] {
  return ranked(current, query).slice(0, K)
}

const ring = new Set<string>()
for (const query of ringQueries) {
  for (const id of ranked(ringDocuments, query).slice(K, K + RING_WIDTH)) ring.add(id)
}
export const outsideTheRing = ringDocuments.filter(document => !ring.has(document.id))

export function search(narsil: Narsil, query: number[]) {
  return narsil.query('papers', {
    mode: 'vector',
    limit: K,
    vector: { field: 'embedding', value: query, metric: 'euclidean' },
  })
}

export async function expectNearest(narsil: Narsil, current: Paper[]): Promise<void> {
  for (const query of queries) {
    const result = await search(narsil, query)
    expect(result.hits.map(hit => hit.id)).toEqual(nearest(current, query))
  }
}

export async function expectOnlyFrom(narsil: Narsil, cluster: Paper[], asked: number[][]): Promise<void> {
  const inCluster = new Set(cluster.map(document => document.id))
  for (const query of asked) {
    const result = await search(narsil, query)
    expect(result.hits.filter(hit => inCluster.has(hit.id))).toHaveLength(K)
  }
}

export async function recallAgainst(narsil: Narsil, current: Paper[]): Promise<number> {
  let found = 0
  for (const query of queries) {
    const truth = new Set(nearest(current, query))
    const result = await search(narsil, query)
    found += result.hits.filter(hit => truth.has(hit.id)).length
  }
  return found / (K * queries.length)
}

export async function ringRecall(narsil: Narsil): Promise<number> {
  let found = 0
  for (const query of ringQueries) {
    const truth = new Set(nearest(outsideTheRing, query))
    const result = await search(narsil, query)
    found += result.hits.filter(hit => truth.has(hit.id)).length
  }
  return found / (K * ringQueries.length)
}

export async function ringAnswers(narsil: Narsil): Promise<string[][]> {
  const answers: string[][] = []
  for (const query of ringQueries) {
    const result = await search(narsil, query)
    answers.push(result.hits.map(hit => hit.id))
  }
  return answers
}

export async function untilGraphSettled(narsil: Narsil): Promise<void> {
  const deadline = Date.now() + SETTLE_DEADLINE_MS
  while (
    narsil
      .vectorMaintenanceStatus('papers')
      .some(field => field.building || field.graphCount === 0 || field.bufferSize > 0)
  ) {
    if (Date.now() > deadline) throw new Error('the graph of papers was still building after 20 s')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

export async function openPapers(
  config: NarsilConfig,
  documents: Paper[],
  papersConfig: IndexConfig = indexConfig,
): Promise<Narsil> {
  const narsil = await createNarsil(config)
  await narsil.createIndex('papers', papersConfig)
  await narsil.insertBatch('papers', documents)
  await untilGraphSettled(narsil)
  return narsil
}

export async function reembed(narsil: Narsil, corpus: Corpus): Promise<void> {
  const result = await narsil.updateBatch(
    'papers',
    corpus.reembedded.map(document => ({ docId: document.id, document })),
  )
  expect(result.failed).toEqual([])
  await untilGraphSettled(narsil)
}

export async function removeChanged(narsil: Narsil, corpus: Corpus): Promise<void> {
  const result = await narsil.removeBatch(
    'papers',
    corpus.changed.map(document => document.id),
  )
  expect(result.failed).toEqual([])
}

export async function openPapersWithoutTheRing(
  config: NarsilConfig,
  papersConfig: IndexConfig = indexConfig,
): Promise<Narsil> {
  const narsil = await openPapers(config, ringDocuments, papersConfig)
  const result = await narsil.removeBatch('papers', [...ring])
  expect(result.failed).toEqual([])
  return narsil
}

export const backends = [
  { name: 'the TypeScript search', native: false, available: true },
  { name: 'the C search', native: true, available: binaryBuilt },
]

export function searchWithTheHostBinary(): void {
  let restoreHostPath: () => void = () => {}

  beforeAll(() => {
    if (!binaryBuilt) return
    restoreHostPath = pointAtTheHostBinary()
    loadNativeCore()
  })

  afterAll(() => {
    restoreHostPath()
  })
}

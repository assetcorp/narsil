import { createNarsilFullSchemaAdapter, createNarsilTextOnlyAdapter } from '../adapters/narsil'
import type { TextJobSpec } from '../runner/jobs'
import { loadTextDataset, type TextDataset } from '../runner/worker-data'
import type { BenchDocument, SearchEngine } from '../types'

export const PUBLISHED_RUN_SEED = 42
export const PUBLISHED_RUN_QUERY_COUNT = 100
export const INSERT_DOCUMENT_COUNT = 1_000
export const SEARCH_DOCUMENT_COUNT = 10_000

export type IndexShape = TextJobSpec['adapter']

export function loadFiqaWorkload(documentCount: number): Promise<TextDataset> {
  return loadTextDataset({
    kind: 'text',
    engine: 'narsil',
    adapter: 'full-schema',
    scale: documentCount,
    dataSource: 'fiqa',
    seed: PUBLISHED_RUN_SEED,
    searchQueryCount: PUBLISHED_RUN_QUERY_COUNT,
  })
}

export function createNarsilEngine(shape: IndexShape): SearchEngine {
  return shape === 'text-only' ? createNarsilTextOnlyAdapter() : createNarsilFullSchemaAdapter()
}

export async function createPopulatedEngine(shape: IndexShape, documents: BenchDocument[]): Promise<SearchEngine> {
  const engine = createNarsilEngine(shape)
  await engine.create()
  await engine.insert(documents)
  return engine
}

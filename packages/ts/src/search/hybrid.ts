import type { PartitionIndex } from '../core/partition'
import type { GlobalStatistics, InternalSearchResult, ScoredDocument } from '../types/internal'
import type { LanguageModule } from '../types/language'
import type { BM25Params, CustomTokenizer, SchemaDefinition } from '../types/schema'
import type { QueryParams } from '../types/search'
import { type FulltextSearchOptions, fulltextSearch } from './fulltext'

export interface HybridSearchOptions {
  bm25Params?: BM25Params
  stopWords?: Set<string> | ((defaults: Set<string>) => Set<string>)
  customTokenizer?: CustomTokenizer
  globalStats?: GlobalStatistics
}

export function hybridSearch(
  partition: PartitionIndex,
  params: QueryParams,
  language: LanguageModule,
  schema: SchemaDefinition,
  options?: HybridSearchOptions,
): InternalSearchResult {
  const hasTerm = params.term !== undefined && params.term.trim().length > 0
  const hasVector = params.vector !== undefined

  if (!hasTerm && !hasVector) {
    return { scored: [], totalMatched: 0 }
  }

  if (hasTerm && !hasVector) {
    return fulltextSearch(partition, params, language, schema, options as FulltextSearchOptions)
  }

  if (!hasTerm && hasVector) {
    return runVectorOnly(partition, params)
  }

  const textResult = fulltextSearch(partition, params, language, schema, options as FulltextSearchOptions)

  const vectorConfig = params.vector as NonNullable<typeof params.vector>
  const vectorResult = partition.searchVector({
    field: vectorConfig.field,
    value: vectorConfig.value,
    k: params.limit ?? 10,
    similarity: vectorConfig.similarity,
    metric: vectorConfig.metric,
  })

  const normalizedText = normalizeScores(textResult.scored)
  const normalizedVector = normalizeScores(vectorResult.scored)

  const mergedMap = new Map<string, { textScore: number; vectorScore: number; textDoc: ScoredDocument | null }>()

  for (const doc of normalizedText) {
    mergedMap.set(doc.docId, {
      textScore: doc.score,
      vectorScore: 0,
      textDoc: findOriginal(textResult.scored, doc.docId),
    })
  }

  for (const doc of normalizedVector) {
    const existing = mergedMap.get(doc.docId)
    if (existing) {
      existing.vectorScore = doc.score
    } else {
      mergedMap.set(doc.docId, { textScore: 0, vectorScore: doc.score, textDoc: null })
    }
  }

  const alpha = clampAlpha(params.hybrid?.alpha)

  const scored: ScoredDocument[] = []
  for (const [docId, entry] of mergedMap) {
    const combinedScore = alpha * entry.vectorScore + (1 - alpha) * entry.textScore
    scored.push({
      docId,
      score: combinedScore,
      termFrequencies: entry.textDoc?.termFrequencies ?? {},
      fieldLengths: entry.textDoc?.fieldLengths ?? {},
      idf: entry.textDoc?.idf ?? {},
    })
  }

  scored.sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))

  let filtered = scored

  if (params.minScore !== undefined && params.minScore > 0) {
    const threshold = params.minScore
    filtered = filtered.filter(doc => doc.score >= threshold)
  }

  if (params.filters) {
    const matchingDocIds = partition.applyFilters(params.filters, schema)
    filtered = filtered.filter(doc => matchingDocIds.has(doc.docId))
  }

  return { scored: filtered, totalMatched: filtered.length }
}

function runVectorOnly(partition: PartitionIndex, params: QueryParams): InternalSearchResult {
  const vectorConfig = params.vector as NonNullable<typeof params.vector>
  const result = partition.searchVector({
    field: vectorConfig.field,
    value: vectorConfig.value,
    k: params.limit ?? 10,
    similarity: vectorConfig.similarity,
    metric: vectorConfig.metric,
  })
  return result
}

function normalizeScores(docs: ScoredDocument[]): Array<{ docId: string; score: number }> {
  if (docs.length === 0) return []

  let min = docs[0].score
  let max = docs[0].score
  for (let i = 1; i < docs.length; i++) {
    if (docs[i].score < min) min = docs[i].score
    if (docs[i].score > max) max = docs[i].score
  }

  const range = max - min
  if (range === 0) {
    return docs.map(d => ({ docId: d.docId, score: 1.0 }))
  }

  return docs.map(d => ({ docId: d.docId, score: (d.score - min) / range }))
}

function clampAlpha(alpha: number | undefined): number {
  if (alpha === undefined) return 0.5
  if (!Number.isFinite(alpha)) return 0.5
  if (alpha < 0) return 0
  if (alpha > 1) return 1
  return alpha
}

function findOriginal(scored: ScoredDocument[], docId: string): ScoredDocument | null {
  for (const doc of scored) {
    if (doc.docId === docId) return doc
  }
  return null
}

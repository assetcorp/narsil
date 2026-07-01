import { generateDocuments, generateFilteredQueries, generateMultiTermQueries, generateQueries } from '../data'
import {
  generatePerfFilteredQueries,
  generatePerfMultiTermQueries,
  generatePerfQueries,
  loadPerfDocuments,
} from '../perf-corpus'
import type { BenchDocument } from '../types'
import type { DataSource, TextJobSpec } from './jobs'

export interface TextDataset {
  docs: BenchDocument[]
  queries: string[]
  multiTermQueries: string[]
  filteredQueries: string[]
}

export async function loadTextDataset(spec: TextJobSpec): Promise<TextDataset> {
  if (spec.dataSource === 'fiqa') {
    const docs = await loadPerfDocuments(spec.scale)
    return {
      docs,
      queries: generatePerfQueries(docs, spec.searchQueryCount, spec.seed + 1),
      multiTermQueries: generatePerfMultiTermQueries(docs, spec.searchQueryCount, spec.seed + 2),
      filteredQueries: generatePerfFilteredQueries(docs, spec.searchQueryCount, spec.seed + 3),
    }
  }
  return {
    docs: generateDocuments(spec.scale, spec.seed),
    queries: generateQueries(spec.searchQueryCount, spec.seed + 1),
    multiTermQueries: generateMultiTermQueries(spec.searchQueryCount, spec.seed + 2),
    filteredQueries: generateFilteredQueries(spec.searchQueryCount, spec.seed + 3),
  }
}

export async function loadDocsAndQueries(
  dataSource: DataSource,
  docCount: number,
  seed: number,
  queryCount: number,
): Promise<{ docs: BenchDocument[]; queries: string[] }> {
  if (dataSource === 'fiqa') {
    const docs = await loadPerfDocuments(docCount)
    return { docs, queries: generatePerfQueries(docs, queryCount, seed + 1) }
  }
  return {
    docs: generateDocuments(docCount, seed),
    queries: generateQueries(queryCount, seed + 1),
  }
}

export async function loadSerializationDocs(
  dataSource: DataSource,
  docCount: number,
  seed: number,
): Promise<{ docs: BenchDocument[]; query: string }> {
  if (dataSource === 'fiqa') {
    const docs = await loadPerfDocuments(docCount)
    return { docs, query: generatePerfQueries(docs, 1, seed + 1)[0] }
  }
  return {
    docs: generateDocuments(docCount, seed),
    query: generateQueries(1, seed + 1)[0],
  }
}

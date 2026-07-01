import { generateDocuments, generateFilteredQueries, generateMultiTermQueries, generateQueries } from '../data'
import {
  generateWikiFilteredQueries,
  generateWikiMultiTermQueries,
  generateWikiQueries,
  loadWikiArticles,
  wikiToBenchDocuments,
} from '../data-wiki'
import type { BenchDocument } from '../types'
import type { DataSource, TextJobSpec } from './jobs'

export interface TextDataset {
  docs: BenchDocument[]
  queries: string[]
  multiTermQueries: string[]
  filteredQueries: string[]
}

export async function loadTextDataset(spec: TextJobSpec): Promise<TextDataset> {
  if (spec.dataSource === 'wiki') {
    const articles = await loadWikiArticles(spec.scale, { noDownload: true })
    const slice = articles.slice(0, spec.scale)
    return {
      docs: wikiToBenchDocuments(slice),
      queries: generateWikiQueries(slice, spec.searchQueryCount, spec.seed + 1),
      multiTermQueries: generateWikiMultiTermQueries(slice, spec.searchQueryCount, spec.seed + 2),
      filteredQueries: generateWikiFilteredQueries(slice, spec.searchQueryCount, spec.seed + 3),
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
  if (dataSource === 'wiki') {
    const articles = await loadWikiArticles(docCount, { noDownload: true })
    const slice = articles.slice(0, docCount)
    return {
      docs: wikiToBenchDocuments(slice),
      queries: generateWikiQueries(slice, queryCount, seed + 1),
    }
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
  if (dataSource === 'wiki') {
    const articles = await loadWikiArticles(docCount, { noDownload: true })
    const slice = articles.slice(0, docCount)
    return {
      docs: wikiToBenchDocuments(slice),
      query: generateWikiQueries(
        [{ title: 'United States', body: 'The United States of America is a country.' }],
        1,
        seed + 1,
      )[0],
    }
  }
  return {
    docs: generateDocuments(docCount, seed),
    query: generateQueries(1, seed + 1)[0],
  }
}

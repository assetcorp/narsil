import { CATEGORIES, createRng } from './data'
import { type BeirDatasetName, loadBeirDataset } from './data/beir'
import type { BenchDocument } from './types'

export const PERF_DATASET: BeirDatasetName = 'fiqa'

function fnv1aHash(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

// FiQA corpus documents carry no numeric score or category. The full-schema tier
// filters on both, so a real distribution is derived here (category from a stable
// hash, score from body length) to keep filtered search doing meaningful work.
export async function loadPerfDocuments(count: number): Promise<BenchDocument[]> {
  const dataset = await loadBeirDataset(PERF_DATASET, {})
  const limit = Math.min(count, dataset.documents.length)
  const docs: BenchDocument[] = []
  for (let i = 0; i < limit; i++) {
    const doc = dataset.documents[i]
    const categoryKey = doc.title.length > 0 ? doc.title : doc.id
    docs.push({
      id: doc.id,
      title: doc.title,
      body: doc.body,
      score: doc.body.length % 100,
      category: CATEGORIES[fnv1aHash(categoryKey) % CATEGORIES.length],
    })
  }
  return docs
}

function termsFor(doc: BenchDocument): string[] {
  return `${doc.title} ${doc.body}`
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2)
}

export function generatePerfQueries(docs: BenchDocument[], count: number, seed: number): string[] {
  const rng = createRng(seed)
  const queries: string[] = []
  for (let i = 0; i < count; i++) {
    const doc = docs[Math.floor(rng() * docs.length)]
    const words = termsFor(doc)
    if (words.length === 0) {
      queries.push(doc.id)
      continue
    }
    const wordCount = 1 + Math.floor(rng() * Math.min(3, words.length))
    const startIdx = Math.floor(rng() * Math.max(1, words.length - wordCount + 1))
    queries.push(words.slice(startIdx, startIdx + wordCount).join(' '))
  }
  return queries
}

export function generatePerfMultiTermQueries(docs: BenchDocument[], count: number, seed: number): string[] {
  const rng = createRng(seed)
  const queries: string[] = []
  for (let i = 0; i < count; i++) {
    const doc = docs[Math.floor(rng() * docs.length)]
    const words = termsFor(doc)
    if (words.length < 2) {
      queries.push(doc.id)
      continue
    }
    const wordCount = 2 + Math.floor(rng() * 2)
    const selected: string[] = []
    for (let j = 0; j < wordCount && j < words.length; j++) {
      selected.push(words[Math.floor(rng() * words.length)])
    }
    queries.push(selected.join(' '))
  }
  return queries
}

export function generatePerfFilteredQueries(docs: BenchDocument[], count: number, seed: number): string[] {
  const rng = createRng(seed)
  const queries: string[] = []
  for (let i = 0; i < count; i++) {
    const doc = docs[Math.floor(rng() * docs.length)]
    const words = termsFor(doc)
    if (words.length === 0) {
      queries.push(doc.id)
      continue
    }
    const wordCount = 1 + Math.floor(rng() * Math.min(2, words.length))
    const startIdx = Math.floor(rng() * Math.max(1, words.length - wordCount + 1))
    queries.push(words.slice(startIdx, startIdx + wordCount).join(' '))
  }
  return queries
}

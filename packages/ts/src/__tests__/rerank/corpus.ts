import type { EmbeddingAdapter } from '../../types/adapters'
import type { IndexConfig } from '../../types/schema'

export const VOCABULARY = [
  'river',
  'stone',
  'light',
  'north',
  'glass',
  'ember',
  'field',
  'storm',
  'quiet',
  'harbor',
  'cedar',
  'lantern',
]

export interface CorpusDocument {
  id: string
  title: string
  tags: string[]
  summary?: string
  category: string
  [field: string]: unknown
}

function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function corpus(size: number, seed = 7): CorpusDocument[] {
  const random = seeded(seed)
  const pick = (): string => VOCABULARY[Math.floor(random() * VOCABULARY.length)]
  const documents: CorpusDocument[] = []
  for (let i = 0; i < size; i++) {
    const titleWords = Array.from({ length: 2 + Math.floor(random() * 5) }, pick)
    const tags = Array.from({ length: Math.floor(random() * 4) }, pick)
    const document: CorpusDocument = {
      id: `doc-${String(i).padStart(4, '0')}`,
      title: titleWords.join(' '),
      tags,
      category: ['alpha', 'beta', 'gamma'][i % 3],
    }
    if (random() < 0.7) document.summary = Array.from({ length: 3 }, pick).join(' ')
    documents.push(document)
  }
  return documents
}

export function letterEmbedding(text: string): Float32Array {
  const vector = new Float32Array(3)
  for (const character of text.toLowerCase()) {
    const code = character.codePointAt(0) ?? 0
    if (code >= 97 && code <= 122) vector[code % 3] += 1 + (code % 5) / 10
  }
  if (vector.every(value => value === 0)) vector[0] = 1
  return vector
}

export const letterEmbedder: EmbeddingAdapter = {
  dimensions: 3,
  async embed(input) {
    return letterEmbedding(input)
  },
}

export const corpusIndex: IndexConfig = {
  schema: {
    title: 'string',
    tags: 'string[]',
    summary: 'string',
    category: 'enum',
    code: 'verbatim',
    embedding: 'vector[3]',
  },
  language: 'english',
  embedding: { adapter: letterEmbedder, fields: { embedding: 'title' } },
}

export function stored(document: CorpusDocument): Record<string, unknown> {
  const { id: _id, ...fields } = document
  return fields
}

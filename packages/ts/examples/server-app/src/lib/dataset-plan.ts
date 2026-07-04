import type { DatasetId } from '@delali/narsil-example-shared/manifest'
import {
  EMBEDDING_FIELD,
  type EmbeddingProviderConfig,
  embeddingSourceFields,
  WIKIPEDIA_LEAD_FIELD,
  WIKIPEDIA_LEAD_MAX_CHARS,
} from './embedding-config'

const WIKIPEDIA_LANGUAGE_NAMES: Record<string, string> = {
  en: 'english',
  fr: 'french',
  ee: 'ewe',
  zu: 'zulu',
  tw: 'twi',
  yo: 'yoruba',
  sw: 'swahili',
  ha: 'hausa',
  dag: 'dagbani',
  ig: 'igbo',
}

export function languageName(code: string): string {
  return WIKIPEDIA_LANGUAGE_NAMES[code] ?? 'english'
}

export interface IndexLoadPlan {
  indexName: string
  datasetId: DatasetId
  schema: Record<string, unknown>
  language: string
  docs: Record<string, unknown>[]
  embedding?: {
    sourceFields: string[]
    dimensions: number
  }
}

/**
 * The server rejects inserting a document whose ID already exists, and the
 * bundled corpora contain occasional repeated rows (movies-100000.json ships
 * two IDs twice), so repeated IDs collapse to their first occurrence.
 */
export function dedupeDocumentsById(docs: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string | number>()
  const unique: Record<string, unknown>[] = []
  for (const doc of docs) {
    const id = doc.id
    if (typeof id === 'string' || typeof id === 'number') {
      if (seen.has(id)) continue
      seen.add(id)
    }
    unique.push(doc)
  }
  return unique
}

/**
 * Cuts the article lead for the embedding input, breaking on a word boundary
 * so the vector never ends mid-word.
 */
export function articleLead(text: string, maxChars: number = WIKIPEDIA_LEAD_MAX_CHARS): string {
  if (text.length <= maxChars) return text
  const slice = text.slice(0, maxChars)
  const lastSpace = slice.lastIndexOf(' ')
  return lastSpace > maxChars / 2 ? slice.slice(0, lastSpace) : slice
}

function withEmbeddingField(schema: Record<string, unknown>, dimensions: number): Record<string, unknown> {
  return { ...schema, [EMBEDDING_FIELD]: `vector[${dimensions}]` }
}

/**
 * Attaches the embedding arrangement to a dataset load when an embedding
 * provider is configured: the schema gains the vector field, and the create
 * request names the server-registered adapter so the search server embeds
 * each document at insert and each query at search time. Without a provider
 * the plan is exactly the keyword-only load this app always performed.
 */
export function planEmbedding(plan: IndexLoadPlan, embedding: EmbeddingProviderConfig | null): IndexLoadPlan {
  if (!embedding) return plan
  const sourceFields = embeddingSourceFields(plan.datasetId)
  if (!sourceFields) return plan

  let schema = withEmbeddingField(plan.schema, embedding.dimensions)
  let docs = plan.docs
  if (plan.datasetId === 'wikipedia') {
    schema = { ...schema, [WIKIPEDIA_LEAD_FIELD]: 'string' }
    docs = docs.map(doc => ({ ...doc, [WIKIPEDIA_LEAD_FIELD]: articleLead(String(doc.text ?? '')) }))
  }

  return {
    ...plan,
    schema,
    docs,
    embedding: { sourceFields, dimensions: embedding.dimensions },
  }
}

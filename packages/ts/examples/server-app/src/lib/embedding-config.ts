import process from 'node:process'
import type { DatasetId } from '@delali/narsil-example-shared/manifest'

export interface EmbeddingProviderConfig {
  apiKey: string
  baseUrl: string
  model: string
  dimensions: number
}

export { EMBEDDING_FIELD } from './ask/types'
export const EMBEDDING_ADAPTER_NAME = 'openai'
export const DEFAULT_EMBEDDING_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small'
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536

/**
 * Wikipedia articles run up to ~190k characters, far past the ~8k-token
 * per-input limit of OpenAI embedding models, so the load pipeline stores the
 * article lead in its own field and embeds that instead of the full text.
 */
export const WIKIPEDIA_LEAD_FIELD = 'lead'
export const WIKIPEDIA_LEAD_MAX_CHARS = 1500

const EMBEDDING_SOURCE_FIELDS: Partial<Record<DatasetId, string[]>> = {
  tmdb: ['title', 'overview', 'tagline'],
  wikipedia: ['title', WIKIPEDIA_LEAD_FIELD],
  scifact: ['title', 'text'],
}

export function embeddingSourceFields(datasetId: DatasetId): string[] | null {
  return EMBEDDING_SOURCE_FIELDS[datasetId] ?? null
}

function validatedBaseUrl(raw: string, envName: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`${envName} is not a valid URL: "${raw}"`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${envName} must use http or https, got "${parsed.protocol}"`)
  }
  return raw.trim().replace(/\/+$/, '')
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/**
 * Resolves the embedding provider from the environment. Returns null when no
 * API key is configured, which keeps every dataset load keyword-only exactly
 * as it was before embeddings existed. Read per call so the demo server and
 * the load pipeline always agree on the current environment.
 */
export function readEmbeddingConfig(): EmbeddingProviderConfig | null {
  const apiKey = firstNonEmpty(process.env.ASK_EMBEDDING_API_KEY, process.env.OPENAI_API_KEY)
  if (apiKey === undefined) return null

  const rawBaseUrl = firstNonEmpty(
    process.env.ASK_EMBEDDING_BASE_URL,
    process.env.OPENAI_BASE_URL,
    DEFAULT_EMBEDDING_BASE_URL,
  ) as string
  const baseUrl = validatedBaseUrl(rawBaseUrl, 'ASK_EMBEDDING_BASE_URL')

  const model = firstNonEmpty(process.env.ASK_EMBEDDING_MODEL, DEFAULT_EMBEDDING_MODEL) as string

  const rawDimensions = firstNonEmpty(process.env.ASK_EMBEDDING_DIMENSIONS)
  let dimensions = DEFAULT_EMBEDDING_DIMENSIONS
  if (rawDimensions !== undefined) {
    dimensions = Number(rawDimensions)
    if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 8192) {
      throw new Error(`ASK_EMBEDDING_DIMENSIONS must be a positive integer up to 8192, got "${rawDimensions}"`)
    }
  }

  return { apiKey, baseUrl, model, dimensions }
}

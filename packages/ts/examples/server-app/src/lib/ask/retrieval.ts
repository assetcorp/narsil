import type { QueryHit, QueryRequest } from '@delali/narsil-example-shared/backend'
import { EMBEDDING_FIELD, WIKIPEDIA_LEAD_FIELD } from '../embedding-config'
import type { RestBackend } from '../rest-backend'
import type { AskSource, RetrievalMode } from './types'

export const MAX_SOURCES = 8

/**
 * Passage budget per source and for the whole prompt context. Eight passages
 * at 1,600 characters is 12,800 characters ≈ 3,200 tokens at the ~4 chars per
 * token English average, which stays a small fraction of any current model's
 * context window while giving the model whole paragraphs to quote from.
 */
export const PASSAGE_MAX_CHARS = 1600
export const CONTEXT_MAX_CHARS = 12800

export interface RetrievedSource extends AskSource {
  /** Plain-text passage for the answer prompt; no markup, length-capped. */
  passage: string
}

export interface RetrievalResult {
  sources: RetrievedSource[]
  elapsedMs: number
}

export class RetrievalModeUnavailableError extends Error {
  constructor(mode: RetrievalMode, indexName: string) {
    super(
      `The "${mode}" mode needs vector embeddings, and the "${indexName}" index has none. ` +
        'Configure an embedding provider (OPENAI_API_KEY or ASK_EMBEDDING_API_KEY) and reload the dataset, ' +
        'or switch to keyword mode.',
    )
    this.name = 'RetrievalModeUnavailableError'
  }
}

function schemaStringFields(schema: Record<string, unknown>): string[] {
  const fields: string[] = []
  for (const [name, type] of Object.entries(schema)) {
    if (type === 'string' && name !== WIKIPEDIA_LEAD_FIELD) fields.push(name)
  }
  return fields
}

/** Keeps <mark> highlight tags and neutralizes every other tag, matching how
 * the search views render engine highlight markup. */
export function sanitizeSnippet(html: string): string {
  return html.replace(/<(?!\/?mark\b)[^>]*>/gi, match => match.replace(/</g, '&lt;').replace(/>/g, '&gt;'))
}

function stripMarkup(snippet: string): string {
  return snippet.replace(/<\/?mark\b[^>]*>/gi, '')
}

function excerpt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const slice = text.slice(0, maxChars)
  const lastSpace = slice.lastIndexOf(' ')
  return `${lastSpace > maxChars / 2 ? slice.slice(0, lastSpace) : slice}...`
}

function sourceTitle(hit: QueryHit): string {
  const title = hit.document.title ?? hit.document.name
  if (typeof title === 'string' && title.trim().length > 0) return title.trim()
  return `Document ${hit.id}`
}

/**
 * Picks the passage the answer is grounded on. Term-based modes get the
 * densest highlight window Narsil found (the same passage shown in the
 * Sources panel); vector-only matches have no term positions, so the passage
 * falls back to the opening of the longest text field.
 */
function buildPassage(hit: QueryHit, bodyFields: string[]): { snippet: string; passage: string } {
  let bestHighlight = ''
  for (const field of bodyFields) {
    const highlight = hit.highlights?.[field]
    if (highlight && highlight.positions.length > 0 && highlight.snippet.length > bestHighlight.length) {
      bestHighlight = highlight.snippet
    }
  }
  if (bestHighlight.length > 0) {
    return {
      snippet: sanitizeSnippet(bestHighlight),
      passage: excerpt(stripMarkup(bestHighlight), PASSAGE_MAX_CHARS),
    }
  }

  let bestBody = ''
  for (const field of bodyFields) {
    const value = hit.document[field]
    if (typeof value === 'string' && value.length > bestBody.length) bestBody = value
  }
  const fallback = excerpt(bestBody, PASSAGE_MAX_CHARS)
  return { snippet: sanitizeSnippet(fallback), passage: fallback }
}

function buildQueryRequest(
  indexName: string,
  mode: RetrievalMode,
  query: string,
  stringFields: string[],
): QueryRequest {
  const highlight = { fields: stringFields, maxSnippetLength: PASSAGE_MAX_CHARS }
  switch (mode) {
    case 'keyword':
      return { indexName, term: query, limit: MAX_SOURCES, highlight }
    case 'semantic':
      return {
        indexName,
        mode: 'vector',
        vector: { field: EMBEDDING_FIELD, text: query },
        limit: MAX_SOURCES,
      }
    case 'hybrid':
      return {
        indexName,
        mode: 'hybrid',
        term: query,
        vector: { field: EMBEDDING_FIELD, text: query },
        hybrid: { strategy: 'rrf' },
        limit: MAX_SOURCES,
        highlight,
      }
  }
}

/**
 * Runs one retrieval pass against the Narsil server and shapes the hits into
 * cited sources. The total passage volume is capped so a run of long
 * documents cannot blow up the prompt.
 */
export async function retrieveSources(
  backend: RestBackend,
  params: { indexName: string; mode: RetrievalMode; query: string; signal?: AbortSignal },
): Promise<RetrievalResult> {
  const { indexName, mode, query, signal } = params

  const stats = await backend.getStats(indexName)
  const schema = stats.schema as Record<string, unknown>
  if (mode !== 'keyword' && !(EMBEDDING_FIELD in schema)) {
    throw new RetrievalModeUnavailableError(mode, indexName)
  }

  const stringFields = schemaStringFields(schema)
  const bodyFields = stringFields.filter(field => field !== 'title')
  const request = buildQueryRequest(indexName, mode, query, stringFields)

  const response = await backend.query(request, signal)

  const sources: RetrievedSource[] = []
  let contextChars = 0
  for (const hit of response.hits) {
    if (sources.length >= MAX_SOURCES) break
    const { snippet, passage } = buildPassage(hit, bodyFields.length > 0 ? bodyFields : stringFields)
    if (contextChars + passage.length > CONTEXT_MAX_CHARS && sources.length > 0) break
    contextChars += passage.length
    sources.push({
      rank: sources.length + 1,
      docId: hit.id,
      indexName,
      title: sourceTitle(hit),
      snippet,
      score: hit.score,
      passage,
    })
  }

  return { sources, elapsedMs: response.elapsed }
}

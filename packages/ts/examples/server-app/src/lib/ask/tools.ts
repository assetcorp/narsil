import { jsonSchema, type ToolSet, tool } from 'ai'
import type { RestBackend } from '../rest-backend'
import { retrieveSources, stripMarkup } from './retrieval'
import type { AskReadInput, AskReadOutput, AskSearchInput, AskSearchOutput, AskSource, RetrievalMode } from './types'

const SEARCH_SNIPPET_MAX_CHARS = 400
/** A document at or under this size comes back whole in one read, so the model
 * rarely needs a second page and can spend its budget reading several different
 * documents instead of one. */
const WHOLE_DOC_MAX_CHARS = 20_000
/** Page size for a document too long to return whole; large enough that the
 * lead and first sections arrive together. */
const READ_PAGE_CHARS = 12_000
/** Sections of a long document the model may reach. Keeping this small stops it
 * from grinding page by page through one article. */
const MAX_PAGES_PER_DOC = 2
const MAX_DOCUMENT_CHARS = 300_000
const PAGE_BOUNDARY_MIN = READ_PAGE_CHARS / 2

interface OpenedDocument {
  citation: number
  title: string
  snippet: string
  score: number
  pages: string[]
}

interface Candidate {
  title: string
  snippet: string
  score: number
}

export interface AskToolset {
  tools: ToolSet
  candidateCount: () => number
}

function documentTitle(document: Record<string, unknown>, docId: string): string {
  const raw = document.title ?? document.name
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim()
  return `Document ${docId}`
}

/** The body the agent reads: the full article in `text`, or the longest string
 * field when a dataset stores its body elsewhere. Length is capped so a single
 * pathological document cannot exhaust memory during pagination. */
function documentBody(document: Record<string, unknown>): string {
  const text = document.text
  if (typeof text === 'string' && text.length > 0) return text.slice(0, MAX_DOCUMENT_CHARS)
  let longest = ''
  for (const value of Object.values(document)) {
    if (typeof value === 'string' && value.length > longest.length) longest = value
  }
  return longest.slice(0, MAX_DOCUMENT_CHARS)
}

/** Returns a reasonable document whole and splits a long one into ordered
 * pages, preferring paragraph, then line, then word boundaries so a page never
 * ends mid-word. The lead is page 0. */
function paginate(body: string): string[] {
  const clean = body.replace(/\r\n/g, '\n').trim()
  if (clean.length <= WHOLE_DOC_MAX_CHARS) return [clean.length > 0 ? clean : '']

  const pages: string[] = []
  let start = 0
  while (start < clean.length) {
    let end = Math.min(start + READ_PAGE_CHARS, clean.length)
    if (end < clean.length) {
      const window = clean.slice(start, end)
      const paragraph = window.lastIndexOf('\n\n')
      const line = window.lastIndexOf('\n')
      const space = window.lastIndexOf(' ')
      const boundary =
        paragraph >= PAGE_BOUNDARY_MIN
          ? paragraph
          : line >= PAGE_BOUNDARY_MIN
            ? line
            : space >= PAGE_BOUNDARY_MIN
              ? space
              : -1
      if (boundary > 0) end = start + boundary
    }
    pages.push(clean.slice(start, end).trim())
    start = end
  }
  return pages
}

/**
 * Builds the two request-scoped retrieval tools the answer agent drives. All
 * mutable state (search candidates, opened documents, per-document read counts,
 * elapsed engine time) stays inside this closure so one request cannot observe
 * another's reads. `onOpen` fires whenever a new document is opened so the
 * caller can stream the opened-document list to the Sources rail, and
 * `candidateCount` lets the caller answer directly when a search found nothing.
 */
export function createAskTools(params: {
  backend: RestBackend
  indexName: string
  mode: RetrievalMode
  signal: AbortSignal
  onOpen: (sources: AskSource[], elapsedMs: number, query: string) => void
}): AskToolset {
  const { backend, indexName, mode, signal, onOpen } = params

  const candidates = new Map<string, Candidate>()
  const opened = new Map<string, OpenedDocument>()
  let elapsedMs = 0
  let firstQuery = ''
  let citationCounter = 0

  const openedSources = (): AskSource[] =>
    [...opened.entries()]
      .map(([docId, entry]) => ({
        rank: entry.citation,
        docId,
        indexName,
        title: entry.title,
        snippet: entry.snippet,
        score: entry.score,
      }))
      .sort((a, b) => a.rank - b.rank)

  const search = tool({
    description:
      'Search the loaded index for documents relevant to a query. Returns up to 8 ranked candidates as docId, title, a short snippet, and score. Snippets are previews only; several candidates usually cover different facets of the question, so open more than just the top one with readDocument before you answer.',
    inputSchema: jsonSchema<AskSearchInput>({
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query. Use the key terms of what you need, not a full sentence.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    }),
    execute: async ({ query }, { abortSignal }): Promise<AskSearchOutput> => {
      const retrieval = await retrieveSources(backend, {
        indexName,
        mode,
        query,
        signal: abortSignal ?? signal,
      })
      elapsedMs += retrieval.elapsedMs
      if (firstQuery.length === 0) firstQuery = query

      const results = retrieval.sources.map(source => {
        candidates.set(source.docId, { title: source.title, snippet: source.snippet, score: source.score })
        return {
          docId: source.docId,
          title: source.title,
          snippet: stripMarkup(source.snippet).slice(0, SEARCH_SNIPPET_MAX_CHARS),
          score: Number(source.score.toFixed(4)),
        }
      })
      return { query, mode, results }
    },
  })

  const readDocument = tool({
    description:
      'Read one candidate document by its docId to get its content. A reasonable document comes back whole; a long one comes back in at most a couple of sections (totalPages/hasMore say if more remains). Read a few different candidates so your answer draws on more than one. Cite each document as [citation], using the returned citation number.',
    inputSchema: jsonSchema<AskReadInput>({
      type: 'object',
      properties: {
        docId: { type: 'string', description: 'The docId of a document returned by search.' },
        page: {
          type: 'integer',
          minimum: 0,
          description: 'Zero-based section to read. Omit or use 0 for the lead; use 1 for the next section.',
        },
      },
      required: ['docId'],
      additionalProperties: false,
    }),
    execute: async ({ docId, page }): Promise<AskReadOutput> => {
      let entry = opened.get(docId)
      if (!entry) {
        const document = await backend.getDocument(indexName, docId)
        if (!document) {
          return {
            docId,
            error: `No document with id "${docId}" exists in the "${indexName}" index. Pick a docId from the search results.`,
          }
        }
        const candidate = candidates.get(docId)
        citationCounter += 1
        entry = {
          citation: citationCounter,
          title: documentTitle(document, docId),
          snippet: candidate?.snippet ?? '',
          score: candidate?.score ?? 0,
          pages: paginate(documentBody(document)),
        }
        opened.set(docId, entry)
        onOpen(openedSources(), elapsedMs, firstQuery)
      }

      const totalPages = Math.min(entry.pages.length, MAX_PAGES_PER_DOC)
      const requested = typeof page === 'number' && Number.isFinite(page) ? Math.floor(page) : 0
      const pageIndex = Math.min(Math.max(requested, 0), totalPages - 1)
      return {
        docId,
        title: entry.title,
        citation: entry.citation,
        page: pageIndex,
        totalPages,
        hasMore: pageIndex < totalPages - 1,
        text: entry.pages[pageIndex] ?? '',
      }
    },
  })

  return {
    tools: { search, readDocument },
    candidateCount: () => candidates.size,
  }
}

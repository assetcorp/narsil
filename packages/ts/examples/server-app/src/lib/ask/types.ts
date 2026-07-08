import type { LanguageModelUsage, UIMessage } from 'ai'

/** Schema field that holds document vectors on embedding-enabled indexes.
 * Lives here rather than in the server-only embedding config so client code
 * can check schemas for it without pulling node:process into the bundle. */
export const EMBEDDING_FIELD = 'embedding'

export type RetrievalMode = 'keyword' | 'semantic' | 'hybrid'

export const RETRIEVAL_MODES: RetrievalMode[] = ['keyword', 'semantic', 'hybrid']

/** One retrieved document as shown in the Sources panel and cited as [rank]. */
export interface AskSource {
  rank: number
  docId: string
  indexName: string
  title: string
  /** Highlighted passage; sanitized so only <mark> tags survive. */
  snippet: string
  score: number
}

export interface AskSourcesData {
  mode: RetrievalMode
  indexName: string
  /** The query the agent's first search ran with; the rail labels the evidence with it. */
  query: string
  elapsedMs: number
  sources: AskSource[]
}

export type AskDataParts = {
  'ask-sources': AskSourcesData
}

/** One candidate the `search` tool hands the model: enough to decide what to open, no full text. */
export interface AskSearchResult {
  docId: string
  title: string
  snippet: string
  score: number
}

export interface AskSearchInput {
  query: string
}

export interface AskSearchOutput {
  query: string
  mode: RetrievalMode
  results: AskSearchResult[]
}

export interface AskReadInput {
  docId: string
  page?: number
}

/** A page of an opened document, plus the stable citation number the answer cites it by. */
export interface AskReadPage {
  docId: string
  title: string
  citation: number
  page: number
  totalPages: number
  hasMore: boolean
  text: string
}

export interface AskReadError {
  docId: string
  error: string
}

export type AskReadOutput = AskReadPage | AskReadError

export function isAskReadError(output: AskReadOutput): output is AskReadError {
  return 'error' in output
}

/** Maps each tool name to its input/output so `message.parts` narrows tool parts with typed `.input`/`.output`. */
export type AskUITools = {
  search: { input: AskSearchInput; output: AskSearchOutput }
  readDocument: { input: AskReadInput; output: AskReadOutput }
}

/** Per-answer token accounting, attached on the stream's finish event so the
 * Context chip can show how much of the model's window the answer consumed.
 * `modelId` is the tokenlens-style `provider:model` identifier used for pricing. */
export interface AskMessageMetadata {
  usage?: LanguageModelUsage
  modelId?: string
}

export type AskUIMessage = UIMessage<AskMessageMetadata, AskDataParts, AskUITools>

export interface AskCapabilities {
  llmConfigured: boolean
  llmModel: string | null
  embeddingsConfigured: boolean
  embeddingModel: string | null
  embeddingDimensions: number | null
}

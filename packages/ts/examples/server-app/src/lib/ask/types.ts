import type { LanguageModelUsage, UIMessage } from 'ai'

export const EMBEDDING_FIELD = 'embedding'

export type RetrievalMode = 'keyword' | 'semantic' | 'hybrid'

export const RETRIEVAL_MODES: RetrievalMode[] = ['keyword', 'semantic', 'hybrid']

export interface AskSource {
  rank: number
  docId: string
  indexName: string
  title: string
  snippet: string
  score: number
}

export interface AskSourcesData {
  mode: RetrievalMode
  indexName: string
  query: string
  elapsedMs: number
  sources: AskSource[]
}

export interface AskThreadTitleData {
  threadId: string
  title: string
}

export type AskDataParts = {
  'ask-sources': AskSourcesData
  'thread-title': AskThreadTitleData
}

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

export type AskUITools = {
  search: { input: AskSearchInput; output: AskSearchOutput }
  readDocument: { input: AskReadInput; output: AskReadOutput }
}

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

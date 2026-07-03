import type { UIMessage } from 'ai'

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
  /** The query string retrieval ran with (a follow-up may be rewritten). */
  query: string
  elapsedMs: number
  sources: AskSource[]
}

export interface AskStatusData {
  phase: 'searching' | 'generating'
}

export type AskDataParts = {
  'ask-sources': AskSourcesData
  'ask-status': AskStatusData
}

export type AskUIMessage = UIMessage<never, AskDataParts>

export interface AskCapabilities {
  llmConfigured: boolean
  llmModel: string | null
  embeddingsConfigured: boolean
  embeddingModel: string | null
  embeddingDimensions: number | null
}

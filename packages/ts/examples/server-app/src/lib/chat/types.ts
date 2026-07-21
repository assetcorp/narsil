import type { AskUIMessage } from '../ask/types'

export interface ThreadSummary {
  id: string
  title: string
  indexName: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

export interface StoredThread extends ThreadSummary {
  messages: AskUIMessage[]
}

export interface StoredThreadWire extends ThreadSummary {
  messages: Record<string, NonNullable<unknown>>[]
}

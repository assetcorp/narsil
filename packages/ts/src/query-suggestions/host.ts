import type { Narsil } from '../types/engine'
import type { NarsilEventMap } from '../types/events'
import type { StoredQuerySuggestions } from '../types/internal'
import type { QuerySuggestionsSource } from '../types/query-suggestions'
import type { SchemaDefinition } from '../types/schema'
import type { BuildRecord } from './build-record'
import type { HistoryFiles } from './history-files'

export interface IndexView {
  state: StoredQuerySuggestions | null
  schema: SchemaDefinition
  language: string
  indexUuid: string | null
  hasSync: boolean
}

export type RemoteFile =
  | { kind: 'file'; nodeId: string; key: string; bytes: Uint8Array }
  | { kind: 'silent'; nodeId: string }

export type StateChange = (current: StoredQuerySuggestions | null) => StoredQuerySuggestions | null

export interface SuggestionsHost {
  readonly engine: Narsil
  readonly nodeId: string
  readonly files: HistoryFiles
  readonly clustered: boolean
  view(indexName: string): IndexView | null
  indexNames(): string[]
  updateState(indexName: string, change: StateChange): Promise<StoredQuerySuggestions | null>
  createSuggestionsIndex(name: string, source: QuerySuggestionsSource, language: string): Promise<void>
  remoteHistory(indexName: string): AsyncIterable<RemoteFile>
  readBuildRecord(indexName: string): Promise<BuildRecord | null>
  writeBuildRecord(indexName: string, record: BuildRecord): Promise<void>
  mayBuild(): boolean
  emit<E extends keyof NarsilEventMap>(name: E, payload: NarsilEventMap[E]): void
}

import type {
  AnyDocument,
  PartitionConfig,
  PreflightResult,
  QueryParams,
  SyncStatus,
  SynonymRule,
} from '@delali/narsil'
import { createContext, useContext } from 'react'

export interface AnalysisChangeRequest {
  language?: string
  stopWords?: string[] | null
}

export interface EngineSyncActions {
  getSync: (indexName: string) => Promise<SyncStatus>
  updateSync: (indexName: string, enabled: boolean) => Promise<void>
}

export interface EngineActions {
  getDocument: (indexName: string, documentId: string) => Promise<AnyDocument | undefined>
  saveDocument: (indexName: string, documentId: string, document: AnyDocument) => Promise<void>
  removeDocument: (indexName: string, documentId: string) => Promise<void>
  preflight: (indexName: string, params: QueryParams) => Promise<PreflightResult>
  getSynonyms: (indexName: string) => Promise<SynonymRule[]>
  updateSynonyms: (indexName: string, synonyms: SynonymRule[]) => Promise<void>
  changeAnalysis: (indexName: string, change: AnalysisChangeRequest) => Promise<void>
  rebalance: (indexName: string, partitionCount: number) => Promise<void>
  updatePartitionConfig: (indexName: string, config: Partial<PartitionConfig>) => Promise<void>
  compactVectors: (indexName: string) => Promise<void>
  optimizeVectors: (indexName: string) => Promise<void>
  snapshot: (indexName: string) => Promise<Blob>
  restore: (indexName: string, archive: Blob) => Promise<void>
  exportDocuments: (indexName: string) => Promise<Blob>
  importDocumentExport: (indexName: string, archive: Blob) => Promise<void>
  sync: EngineSyncActions | null
  groupTotals: boolean
  rerankAdapter: string
  onChanged: (indexName: string) => void
}

export const EngineActionsContext = createContext<EngineActions | null>(null)

export function useEngineActions(): EngineActions {
  const actions = useContext(EngineActionsContext)
  if (actions === null) {
    throw new Error('The engine actions must be provided through EngineActionsContext')
  }
  return actions
}

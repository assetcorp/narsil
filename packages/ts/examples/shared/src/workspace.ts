import { createContext, useContext } from 'react'
import type { LoadedIndex, TabId, TabStatus } from './types'

export interface IndexWorkspace {
  indexes: LoadedIndex[]
  activeIndexName: string | null
  setActiveIndexName: (indexName: string) => void
  tabStatus: Record<TabId, TabStatus>
  isLoading: boolean
  error: string | null
  refresh: () => void
}

export const IndexWorkspaceContext = createContext<IndexWorkspace | null>(null)

export function useIndexWorkspace(): IndexWorkspace {
  const workspace = useContext(IndexWorkspaceContext)
  if (workspace === null) {
    throw new Error('useIndexWorkspace must be used within an IndexWorkspaceContext provider')
  }
  return workspace
}

export function useActiveIndex(): LoadedIndex | null {
  const { indexes, activeIndexName } = useIndexWorkspace()
  return indexes.find(index => index.name === activeIndexName) ?? null
}

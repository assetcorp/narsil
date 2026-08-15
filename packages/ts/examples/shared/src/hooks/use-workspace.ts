import type { IndexInfo } from '@delali/narsil'
import { useCallback, useMemo, useState } from 'react'
import { computeTabStatus, type LoadedIndex, toLoadedIndexes } from '../types'
import type { IndexWorkspace } from '../workspace'

const NO_INDEXES: LoadedIndex[] = []

export interface IndexSource {
  data: IndexInfo[] | undefined
  isLoading: boolean
  error: Error | undefined
  refresh: () => void
}

/**
 * Turns whatever the app used to list the indexes into the workspace the
 * panels read. The chosen index falls back to the first one whenever the
 * choice is gone, which covers a dataset the visitor has just removed.
 */
export function useWorkspace(source: IndexSource): IndexWorkspace {
  const [chosen, setActiveIndexName] = useState<string | null>(null)

  const indexes = useMemo(() => (source.data === undefined ? NO_INDEXES : toLoadedIndexes(source.data)), [source.data])
  const activeIndexName = indexes.find(index => index.name === chosen)?.name ?? indexes[0]?.name ?? null
  const tabStatus = useMemo(() => computeTabStatus(indexes), [indexes])

  const { refresh } = source
  const stableRefresh = useCallback(() => {
    refresh()
  }, [refresh])

  return useMemo(
    () => ({
      indexes,
      activeIndexName,
      setActiveIndexName,
      tabStatus,
      isLoading: source.isLoading,
      error: source.error?.message ?? null,
      refresh: stableRefresh,
    }),
    [indexes, activeIndexName, tabStatus, source.isLoading, source.error, stableRefresh],
  )
}

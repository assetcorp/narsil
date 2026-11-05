import { QUERY_HISTORY_FOLDER } from '../../query-suggestions/constants'
import type { DurabilityManager, HistoryStorage } from './types'

export async function removeQueryHistoryOf(storage: HistoryStorage, indexName: string): Promise<void> {
  const folder = `${QUERY_HISTORY_FOLDER}/${indexName}/`
  if (storage.kind === 'directory') {
    for (const key of await storage.directory.list(folder)) await storage.directory.remove(key)
    return
  }
  for (const key of await storage.adapter.list(folder)) await storage.adapter.delete(key)
}

export function queryHistoryAccess(
  storage: HistoryStorage,
): Required<Pick<DurabilityManager, 'historyStorage' | 'removeQueryHistory'>> {
  return {
    historyStorage: () => storage,
    removeQueryHistory: indexName => removeQueryHistoryOf(storage, indexName),
  }
}

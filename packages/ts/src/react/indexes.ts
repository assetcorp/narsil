import type { IndexInfo, IndexStats } from '../types/results'
import type { NarsilReadOptions, NarsilReadState } from './options'
import { useProviderRead } from './read'
import { ANY_INDEX } from './store'

/**
 * This hook lists every index that the server or the engine holds, with the
 * size and the language of each one. Under an engine, the hook fetches the list
 * again after each burst of writes to any index.
 *
 * @param options - These settings can switch the hook off, keep the last list
 * on screen, and set the refresh interval, the headers, and the deadline.
 * @returns The state holds the indexes in the order of their creation.
 *
 * @public
 */
export function useIndexes(options?: NarsilReadOptions): NarsilReadState<IndexInfo[]> {
  return useProviderRead(['listIndexes'], (reader, request) => reader.listIndexes(request), options, ANY_INDEX)
}

/**
 * This hook fetches the document count, the partition count, the memory
 * estimate, the language, and the schema of one index.
 *
 * Set `refreshIntervalMs` to watch the figures change while a load is in
 * progress. Under an engine, the hook fetches the figures again after each
 * burst of writes to the index.
 *
 * @param indexName - This is the name of the index to describe.
 * @param options - These settings can switch the hook off, keep the last
 * figures on screen, and set the refresh interval, the headers, and the
 * deadline.
 * @returns The state holds the figures as they stood when the server or the
 * engine returned them.
 *
 * @public
 */
export function useStats(indexName: string, options?: NarsilReadOptions): NarsilReadState<IndexStats> {
  return useProviderRead(
    ['getStats', indexName],
    (reader, request) => reader.getStats(indexName, request),
    options,
    indexName,
  )
}

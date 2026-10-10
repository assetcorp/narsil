import type { IndexInfo, IndexStats } from '../types/results'
import type { NarsilReadOptions, NarsilReadState } from './options'
import { useRead } from './read'
import { ANY_INDEX } from './store'

/**
 * Lists every index that the server or the engine holds, with its size and its
 * language. Under an engine, the hook fetches the list again after a write to
 * any index.
 *
 * @param options - These switch the hook off, keep the last list on screen, and
 * set the refresh interval, the headers, and the deadline.
 * @returns The state holds the indexes in creation order.
 *
 * @public
 */
export function useIndexes(options?: NarsilReadOptions): NarsilReadState<IndexInfo[]> {
  return useRead(['listIndexes'], (reader, request) => reader.listIndexes(request), options, ANY_INDEX)
}

/**
 * Reads one index's document count, partition count, memory estimate, language,
 * and schema.
 *
 * Set `refreshIntervalMs` to watch the figures move while a load is in
 * progress. Under an engine, the hook fetches the figures again after a write
 * to the index.
 *
 * @param indexName - This names the index to describe.
 * @param options - These switch the hook off, keep the last figures on screen,
 * and set the refresh interval, the headers, and the deadline.
 * @returns The state holds the figures as they stood when the server or the
 * engine answered.
 *
 * @public
 */
export function useStats(indexName: string, options?: NarsilReadOptions): NarsilReadState<IndexStats> {
  return useRead(['getStats', indexName], (reader, request) => reader.getStats(indexName, request), options, indexName)
}

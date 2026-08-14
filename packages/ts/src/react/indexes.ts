import type { IndexInfo, IndexStats } from '../types/results'
import { type NarsilReadOptions, type NarsilReadState, useRead } from './read'

/**
 * Lists every index the server holds, with its size and its language.
 *
 * @param options - These switch the hook off, keep the last list on screen, and
 * set the refresh interval, the headers, and the deadline.
 * @returns The state holds the indexes in creation order.
 *
 * @public
 */
export function useIndexes(options?: NarsilReadOptions): NarsilReadState<IndexInfo[]> {
  return useRead(['listIndexes'], (client, request) => client.listIndexes(request), options)
}

/**
 * Reads one index's document count, partition count, memory estimate, language,
 * and schema.
 *
 * Set `refreshIntervalMs` to watch the figures move while a load runs.
 *
 * @param indexName - This names the index to describe.
 * @param options - These switch the hook off, keep the last figures on screen,
 * and set the refresh interval, the headers, and the deadline.
 * @returns The state holds the figures as they stood when the server answered.
 *
 * @public
 */
export function useStats(indexName: string, options?: NarsilReadOptions): NarsilReadState<IndexStats> {
  return useRead(['getStats', indexName], (client, request) => client.getStats(indexName, request), options)
}

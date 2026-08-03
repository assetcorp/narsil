import type { InvalidationAdapter } from '../types/adapters'

/**
 * Builds an invalidation adapter that discards every event, which suits a
 * single process holding a store nothing else writes to.
 *
 * Use it to satisfy code paths that expect an adapter without paying for a
 * channel, and swap in {@link createFilesystemInvalidation} or
 * {@link createBroadcastChannelInvalidation} once a second instance shares the
 * store.
 *
 * @returns An adapter you pass as `invalidation` when creating an engine.
 *
 * @public
 */
export function createNoopInvalidation(): InvalidationAdapter {
  return {
    async publish(): Promise<void> {},

    async subscribe(): Promise<void> {},

    async shutdown(): Promise<void> {},
  }
}

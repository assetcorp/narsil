import type { InvalidationAdapter, InvalidationEvent } from '../types/adapters'

declare const BroadcastChannel: {
  new (name: string): BroadcastChannelInstance
  prototype: BroadcastChannelInstance
}

interface BroadcastChannelInstance {
  onmessage: ((ev: { data: unknown }) => void) | null
  postMessage(data: unknown): void
  close(): void
}

/**
 * Which channel {@link createBroadcastChannelInvalidation} publishes on.
 *
 * @public
 */
export interface BroadcastChannelInvalidationConfig {
  /** Every participating tab or worker must name the same channel. The adapter uses `narsil-invalidation` by default. */
  channelName?: string
}

const DEFAULT_CHANNEL_NAME = 'narsil-invalidation'

function isInvalidationEvent(data: unknown): data is InvalidationEvent {
  if (typeof data !== 'object' || data === null) {
    return false
  }
  const record = data as Record<string, unknown>
  return record.type === 'partition' || record.type === 'statistics'
}

/**
 * Builds an invalidation adapter that carries partition changes over the
 * browser's `BroadcastChannel`, which is how several tabs sharing one
 * IndexedDB index stay consistent.
 *
 * The browser delivers each event at once instead of on a poll, so a write in
 * one tab reaches the others as soon as it dispatches.
 *
 * @param config - The channel name. Omit it to accept the default.
 * @returns An adapter you pass as `invalidation` when creating an engine.
 *
 * @public
 */
export function createBroadcastChannelInvalidation(config?: BroadcastChannelInvalidationConfig): InvalidationAdapter {
  const channelName = config?.channelName ?? DEFAULT_CHANNEL_NAME
  let channel: BroadcastChannelInstance | null = null

  function getChannel(): BroadcastChannelInstance {
    if (channel !== null) {
      return channel
    }

    if (typeof BroadcastChannel === 'undefined') {
      throw new Error(
        'BroadcastChannel is not available in this environment. ' +
          'Use a different invalidation adapter, or run in a browser or worker context that supports BroadcastChannel.',
      )
    }

    channel = new BroadcastChannel(channelName)
    return channel
  }

  return {
    async publish(event: InvalidationEvent): Promise<void> {
      getChannel().postMessage(event)
    },

    async subscribe(fn: (event: InvalidationEvent) => void): Promise<void> {
      const ch = getChannel()
      ch.onmessage = (e: { data: unknown }) => {
        if (isInvalidationEvent(e.data)) {
          fn(e.data)
        }
      }
    },

    async shutdown(): Promise<void> {
      if (channel !== null) {
        channel.close()
        channel = null
      }
    },
  }
}

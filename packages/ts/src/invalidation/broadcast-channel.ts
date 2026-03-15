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

export interface BroadcastChannelInvalidationConfig {
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

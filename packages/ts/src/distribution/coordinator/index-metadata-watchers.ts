import { indexNameOfMetadataKey } from './index-metadata-key'
import type { IndexMetadataEvent } from './types'

export interface IndexMetadataWatchers {
  watch(handler: (event: IndexMetadataEvent) => void): () => void
  emit(key: string, value: Uint8Array | null): void
}

export function createIndexMetadataWatchers(): IndexMetadataWatchers {
  const handlers = new Set<(event: IndexMetadataEvent) => void>()
  return {
    watch(handler) {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    emit(key, value) {
      const indexName = indexNameOfMetadataKey(key)
      if (indexName === null) return
      const metadata = value === null || value.byteLength === 0 ? null : new Uint8Array(value)
      for (const handler of handlers) {
        try {
          handler({ indexName, metadata })
        } catch (_) {}
      }
    },
  }
}

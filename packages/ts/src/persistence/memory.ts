import type { PersistenceAdapter } from '../types/adapters'

export function createMemoryPersistence(): PersistenceAdapter {
  const store = new Map<string, Uint8Array>()

  return {
    async save(key: string, data: Uint8Array): Promise<void> {
      store.set(key, new Uint8Array(data))
    },

    async load(key: string): Promise<Uint8Array | null> {
      const stored = store.get(key)
      if (stored === undefined) {
        return null
      }
      return new Uint8Array(stored)
    },

    async delete(key: string): Promise<void> {
      store.delete(key)
    },

    async list(prefix: string): Promise<string[]> {
      const results: string[] = []
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) {
          results.push(key)
        }
      }
      return results
    },
  }
}

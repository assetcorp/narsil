import { createMemoryPersistence } from '../../../persistence/memory'
import type { PersistenceAdapter } from '../../../types/adapters'

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let settle = (): void => undefined
  const promise = new Promise<void>(resolve => {
    settle = resolve
  })
  return { promise, resolve: () => settle() }
}

export function settledAfter(promise: Promise<unknown>, milliseconds: number): Promise<void> {
  return Promise.race([
    promise.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>(resolve => setTimeout(resolve, milliseconds)),
  ])
}

export interface GatedStore {
  adapter: PersistenceAdapter
  storage: ReturnType<typeof createMemoryPersistence>
  holdNextSave(matches?: (key: string) => boolean): { started: Promise<void>; release: () => void }
}

function inProse(key: string): boolean {
  return key.startsWith('prose/')
}

export function gatedStore(): GatedStore {
  const storage = createMemoryPersistence()
  let hold: { matches: (key: string) => boolean; started: () => void; gate: Promise<void> } | null = null
  const adapter: PersistenceAdapter = {
    async save(key, data) {
      const held = hold
      if (held?.matches(key)) {
        hold = null
        held.started()
        await held.gate
      }
      await storage.save(key, data)
    },
    load: key => storage.load(key),
    delete: key => storage.delete(key),
    list: prefix => storage.list(prefix),
  }
  return {
    adapter,
    storage,
    holdNextSave(matches = inProse) {
      const started = deferred()
      const gate = deferred()
      hold = { matches, started: started.resolve, gate: gate.promise }
      return { started: started.promise, release: gate.resolve }
    },
  }
}

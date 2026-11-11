export type SyncChange =
  | { kind: 'epoch'; indexName: string }
  | { kind: 'off'; indexName: string }
  | { kind: 'settings'; indexName: string }
  | { kind: 'dropped'; indexName: string }
  | { kind: 'changes-off'; indexName: string }
  | { kind: 'previous-document-off'; indexName: string }

export type SyncChangeListener = (change: SyncChange) => void

const listenersByRegistry = new WeakMap<object, Set<SyncChangeListener>>()

export function listenForSyncChanges(registry: object, listener: SyncChangeListener): () => void {
  let listeners = listenersByRegistry.get(registry)
  if (listeners === undefined) {
    listeners = new Set()
    listenersByRegistry.set(registry, listeners)
  }
  const registered = listeners
  registered.add(listener)
  return () => {
    registered.delete(listener)
  }
}

export function emitSyncChange(registry: object, change: SyncChange): void {
  const listeners = listenersByRegistry.get(registry)
  if (listeners === undefined) return
  for (const listener of [...listeners]) listener(change)
}

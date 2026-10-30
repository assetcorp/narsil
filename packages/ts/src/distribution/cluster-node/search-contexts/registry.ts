import { generateId } from '../../../core/id-generator'
import { SEARCH_CONTEXT_KEEP_ALIVE_LIMIT_MS } from '../../query/constants'
import { SEARCH_CONTEXT_REAPER_INTERVAL_MS } from '../constants'
import type { DocumentSnapshot } from './snapshots'

interface SearchContext {
  coordinatorNodeId: string
  keepAliveMs: number
  expiresAt: number
  documents: ReadonlyMap<string, DocumentSnapshot>
}

export interface SearchContextRegistry {
  open(coordinatorNodeId: string, keepAliveMs: number, documents: ReadonlyMap<string, DocumentSnapshot>): string
  read(contextId: string, docIds: readonly string[]): Map<string, DocumentSnapshot> | null
  release(contextId: string): void
  releaseCoordinator(coordinatorNodeId: string): void
  openCount(): number
  stop(): void
}

export function keepAliveOf(requested: number): number {
  return Math.min(requested, SEARCH_CONTEXT_KEEP_ALIVE_LIMIT_MS)
}

export function createSearchContextRegistry(now: () => number = () => performance.now()): SearchContextRegistry {
  const contexts = new Map<string, SearchContext>()
  let reaper: ReturnType<typeof setInterval> | null = null

  function reap(): void {
    const at = now()
    for (const [contextId, context] of contexts) {
      if (context.expiresAt <= at) contexts.delete(contextId)
    }
    if (contexts.size === 0) stopReaper()
  }

  function startReaper(): void {
    if (reaper !== null) return
    reaper = setInterval(reap, SEARCH_CONTEXT_REAPER_INTERVAL_MS)
    if (typeof reaper === 'object' && 'unref' in reaper) reaper.unref()
  }

  function stopReaper(): void {
    if (reaper === null) return
    clearInterval(reaper)
    reaper = null
  }

  return {
    open(coordinatorNodeId, keepAliveMs, documents) {
      const contextId = generateId()
      contexts.set(contextId, { coordinatorNodeId, keepAliveMs, expiresAt: now() + keepAliveMs, documents })
      startReaper()
      return contextId
    },
    read(contextId, docIds) {
      const context = contexts.get(contextId)
      if (context === undefined) return null
      const at = now()
      if (context.expiresAt <= at) {
        contexts.delete(contextId)
        return null
      }
      context.expiresAt = at + context.keepAliveMs
      const found = new Map<string, DocumentSnapshot>()
      for (const docId of docIds) {
        const snapshot = context.documents.get(docId)
        if (snapshot !== undefined) found.set(docId, snapshot)
      }
      return found
    },
    release(contextId) {
      contexts.delete(contextId)
      if (contexts.size === 0) stopReaper()
    },
    releaseCoordinator(coordinatorNodeId) {
      for (const [contextId, context] of contexts) {
        if (context.coordinatorNodeId === coordinatorNodeId) contexts.delete(contextId)
      }
      if (contexts.size === 0) stopReaper()
    },
    openCount: () => contexts.size,
    stop() {
      contexts.clear()
      stopReaper()
    },
  }
}

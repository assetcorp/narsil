import { DEFAULT_TRANSPORT_CONFIG, type NodeTransport } from '../transport/types'
import { createFetchMessage } from './codec'
import { SEARCH_CONTEXT_KEEP_ALIVE_LIMIT_MS, SEARCH_CONTEXT_KEEP_ALIVE_MS } from './constants'
import type { CopyRouting } from './failover'
import type { NodeQueryOutcome } from './fan-out'
import { resolveTargets, sendToFirstReachableTarget } from './node-send'
import type { QueryRoutingDeps } from './types'

export interface RankingContext {
  nodeId: string
  contextId: string
}

export interface SearchContextSet {
  sources: Map<string, RankingContext>
  opened: RankingContext[]
}

export function searchContextKeepAlive(
  routing: CopyRouting,
  partitionTimeout: number,
  transport: NodeTransport,
): number {
  let copies = 1
  for (const partitionCopies of routing.copiesByPartition.values()) copies = Math.max(copies, partitionCopies.length)
  const requestTimeout = transport.timeouts?.requestTimeout ?? DEFAULT_TRANSPORT_CONFIG.requestTimeout
  const longestGap = partitionTimeout * copies + 2 * requestTimeout
  return Math.min(SEARCH_CONTEXT_KEEP_ALIVE_LIMIT_MS, Math.max(SEARCH_CONTEXT_KEEP_ALIVE_MS, longestGap))
}

export function collectSearchContexts(...outcomeSets: NodeQueryOutcome[][]): SearchContextSet {
  const sources = new Map<string, RankingContext>()
  const opened: RankingContext[] = []
  for (const outcomes of outcomeSets) {
    for (const outcome of outcomes) {
      const contextId = outcome.status === 'success' ? (outcome.results?.contextId ?? null) : null
      if (contextId === null || outcome.results === null) continue
      const context: RankingContext = { nodeId: outcome.nodeId, contextId }
      opened.push(context)
      for (const partition of outcome.results.results) {
        for (const entry of partition.scored) if (!sources.has(entry.docId)) sources.set(entry.docId, context)
      }
      for (const group of outcome.results.groups ?? []) {
        for (const entry of group.scored) if (!sources.has(entry.docId)) sources.set(entry.docId, context)
      }
    }
  }
  return { sources, opened }
}

export function releaseSearchContexts(
  indexName: string,
  contexts: readonly RankingContext[],
  deps: Pick<QueryRoutingDeps, 'transport' | 'sourceNodeId' | 'resolveNodeTargets'>,
): void {
  for (const context of contexts) {
    const message = createFetchMessage(
      {
        indexName,
        documentIds: [],
        fields: null,
        highlight: null,
        contextId: context.contextId,
        releaseContext: true,
      },
      deps.sourceNodeId,
    )
    resolveTargets(context.nodeId, deps)
      .then(targets => sendToFirstReachableTarget(deps.transport, targets, message))
      .catch(() => undefined)
  }
}

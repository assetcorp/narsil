import type { EngineCore } from '../engine/core'
import type { RerankRunner } from '../engine/query/shared'
import { rerankOnHost } from './call'
import { ErrorCodes, MAX_CALLS_ACROSS_INDEX_CHANGES, NarsilError } from './rerank-host-bindings'

export type OutsideIndexHold = <T>(work: () => Promise<T>) => Promise<T>

export function rerankRunnerFor(
  core: EngineCore,
  signal: AbortSignal | undefined,
  outsideHold: OutsideIndexHold,
): RerankRunner {
  return {
    maxWindow: core.rerankSettings.maxWindow,
    score: (adapter, query, documents) => outsideHold(() => rerankOnHost(core, adapter, query, documents, signal)),
  }
}

export function refuseAfterIndexChanges(indexName: string, attempts: number): void {
  if (attempts < MAX_CALLS_ACROSS_INDEX_CHANGES) return
  throw new NarsilError(
    ErrorCodes.WORKER_BUSY,
    `Changes to index "${indexName}" replaced it during each of ${attempts} calls to its rerank adapter`,
    { indexName, attempts },
  )
}

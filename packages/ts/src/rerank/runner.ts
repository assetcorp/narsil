import type { EngineCore } from '../engine/core'
import type { IndexHold } from '../engine/index-hold'
import type { RerankRunner } from '../engine/query/shared'
import type { PartitionManager } from '../partitioning/manager/types'
import { rerankOnHost } from './call'
import { ErrorCodes, MAX_CALLS_ACROSS_INDEX_CHANGES, NarsilError } from './rerank-host-bindings'

export interface HeldIndexRerankRunner extends RerankRunner {
  readonly replaced: boolean
}

export function rerankRunnerFor(
  core: EngineCore,
  signal: AbortSignal | undefined,
  hold: IndexHold,
  indexName: string,
  manager: PartitionManager,
): HeldIndexRerankRunner {
  let replaced = false
  return {
    get replaced() {
      return replaced
    },
    maxWindow: core.rerankSettings.maxWindow,
    async score(adapter, query, documents) {
      try {
        return await hold.outside(() => rerankOnHost(core, adapter, query, documents, signal))
      } finally {
        replaced ||= core.executor.getManager(indexName) !== manager
      }
    },
  }
}

export function refuseAfterIndexChanges(indexName: string, replacedReranks: number): void {
  if (replacedReranks < MAX_CALLS_ACROSS_INDEX_CHANGES) return
  throw new NarsilError(
    ErrorCodes.WORKER_BUSY,
    `Changes to index "${indexName}" replaced it during each of ${replacedReranks} calls to its rerank adapter`,
    { indexName, attempts: replacedReranks },
  )
}

import type { EngineCore } from '../engine/core'
import type { RerankRunner } from '../engine/query/shared'
import { rerankOnHost } from './call'

export function rerankRunnerFor(core: EngineCore): RerankRunner {
  return {
    maxWindow: core.rerankSettings.maxWindow,
    score: (adapter, query, documents) => rerankOnHost(core, adapter, query, documents),
  }
}

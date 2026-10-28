import type { LanguageModule } from '../types/language'
import type { IndexConfig } from '../types/schema'
import type { VectorWorkerCopyPolicy } from '../vector/vector-index'
import type { DetachedIndex, IndexReplacement } from './direct-executor'

function attachablePolicy(shared: VectorWorkerCopyPolicy): { policy: VectorWorkerCopyPolicy; attach(): void } {
  let attached = false
  const policy: VectorWorkerCopyPolicy = {
    get enabled() {
      return attached && shared.enabled
    },
    get count() {
      return shared.count
    },
    get host() {
      return shared.host
    },
  }
  return {
    policy,
    attach() {
      attached = true
    },
  }
}

export function createDetachedIndex(
  indexName: string,
  config: IndexConfig,
  language: LanguageModule,
  executor: Pick<IndexReplacement, 'vectorWorkerCopies' | 'createDetachedEntry'>,
): DetachedIndex {
  const { policy, attach } = attachablePolicy(executor.vectorWorkerCopies)
  const entry = executor.createDetachedEntry(indexName, config, language, policy)
  return { indexName, manager: entry.manager, entry, attach }
}

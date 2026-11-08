import { createWorkerFactory } from '#platform/worker-factory'
import { isCompositePartition } from '../../core/partition/composite'
import { NO_REMOVED_SPELLINGS } from '../../core/partition/frozen/removal-pass'
import { encodeSegmentState } from '../../core/partition/segment-payload'
import { patternHost } from '../../core/pattern-index/host'
import { availablePatternSearch } from '../../core/pattern-index/registry'
import { kWayMerge } from '../../partitioning/fan-out'
import { resolvePartitionInsertOptions } from '../../partitioning/insert-options'
import { extractVectorFieldsFromSchema } from '../../schema/validator'
import { schemaFieldsOf } from '../../schema/validator/schema'
import { oversampledFacetConfig } from '../../search/facets'
import { returnsEveryMatch } from '../../search/fulltext'
import { growPartitionsTo } from '../../workers/segment-action-code'
import { threadSlotOfWorker } from '../../workers/thread-slot'
import { requireLoadedVectorCode } from '../../workers/vector-code'
import { resolveRequestThreadCount, splitWorkerBudget } from '../../workers/worker-count'
import { LIVE_TAIL_FREEZE_FLOOR } from '../orchestration/constants'
import { workersEnabledByDefault } from '../orchestration/loader'
import { afterCurrentTurn, yieldToEventLoop } from '../orchestration/turn'

export function workersHostPart() {
  return {
    LIVE_TAIL_FREEZE_FLOOR,
    NO_REMOVED_SPELLINGS,
    afterCurrentTurn,
    availablePatternSearch,
    createWorkerFactory,
    encodeSegmentState,
    extractVectorFieldsFromSchema,
    growPartitionsTo,
    isCompositePartition,
    kWayMerge,
    oversampledFacetConfig,
    patternHost,
    requireLoadedVectorCode,
    resolvePartitionInsertOptions,
    resolveRequestThreadCount,
    returnsEveryMatch,
    schemaFieldsOf,
    splitWorkerBudget,
    threadSlotOfWorker,
    workersEnabledByDefault,
    yieldToEventLoop,
  }
}

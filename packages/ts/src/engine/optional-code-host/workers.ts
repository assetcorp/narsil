import { createWorkerFactory } from '#platform/worker-factory'
import { isCompositePartition } from '../../core/partition/composite'
import { NO_REMOVED_SPELLINGS } from '../../core/partition/frozen/removal-pass'
import { encodeSegmentState } from '../../core/partition/segment-payload'
import { MATCHER_STATE_BUDGET_BYTES } from '../../core/pattern-index/constants'
import { patternHost } from '../../core/pattern-index/host'
import { availablePatternSearch } from '../../core/pattern-index/registry'
import { kWayMerge } from '../../partitioning/fan-out'
import { resolvePartitionInsertOptions } from '../../partitioning/insert-options'
import { extractVectorFieldsFromSchema } from '../../schema/validator'
import { schemaFieldsOf } from '../../schema/validator/schema'
import { oversampledFacetConfig } from '../../search/facets'
import { returnsEveryMatch } from '../../search/fulltext'
import {
  CONSECUTIVE_TIMEOUTS_BEFORE_DEATH,
  DEFAULT_BACKPRESSURE_LIMIT,
  DEFAULT_REQUEST_TIMEOUT_MS,
  SHUTDOWN_TIMEOUT_MS,
} from '../../workers/constants'
import { growPartitionsTo } from '../../workers/segment-action-code'
import { threadSlotOfWorker } from '../../workers/thread-slot'
import { requireLoadedVectorCode } from '../../workers/vector-code'
import { resolveRequestThreadCount, splitWorkerBudget } from '../../workers/worker-count'
import { MAX_SWEEP_INTERVAL_MS, MIN_SWEEP_INTERVAL_MS } from '../constants'
import {
  COMPACTION_SEGMENT_TRIGGER,
  DEFAULT_COPY_IDLE_TIMEOUT_MS,
  DEFAULT_COPY_THRESHOLD,
  IDLE_MERGE_DELAY_MS,
  LIVE_TAIL_FLUSH_DOCUMENTS,
  LIVE_TAIL_FREEZE_FLOOR,
  LOAD_BUFFER_YIELD_INTERVAL,
  LONG_QUERY_THREADS,
  MAIN_COPY_LONE_QUERY_DOCUMENTS,
  MAX_PENDING_REPLICATION_DOCUMENTS,
  POOL_RESTART_DELAY_MAX_MS,
  POOL_RESTART_DELAY_MS,
  REPLICATION_WINDOW,
  RETIRED_THREADS_EXIT_WAIT_MS,
  SEGMENTS_PER_MERGE,
} from '../orchestration/constants'
import { workersEnabledByDefault } from '../orchestration/loader'
import { afterCurrentTurn, yieldToEventLoop } from '../orchestration/turn'

export function workersHostPart() {
  return {
    COMPACTION_SEGMENT_TRIGGER,
    CONSECUTIVE_TIMEOUTS_BEFORE_DEATH,
    DEFAULT_BACKPRESSURE_LIMIT,
    DEFAULT_COPY_IDLE_TIMEOUT_MS,
    DEFAULT_COPY_THRESHOLD,
    DEFAULT_REQUEST_TIMEOUT_MS,
    IDLE_MERGE_DELAY_MS,
    LIVE_TAIL_FLUSH_DOCUMENTS,
    LIVE_TAIL_FREEZE_FLOOR,
    LOAD_BUFFER_YIELD_INTERVAL,
    LONG_QUERY_THREADS,
    MAIN_COPY_LONE_QUERY_DOCUMENTS,
    MATCHER_STATE_BUDGET_BYTES,
    MAX_PENDING_REPLICATION_DOCUMENTS,
    MAX_SWEEP_INTERVAL_MS,
    MIN_SWEEP_INTERVAL_MS,
    NO_REMOVED_SPELLINGS,
    POOL_RESTART_DELAY_MAX_MS,
    POOL_RESTART_DELAY_MS,
    REPLICATION_WINDOW,
    RETIRED_THREADS_EXIT_WAIT_MS,
    SEGMENTS_PER_MERGE,
    SHUTDOWN_TIMEOUT_MS,
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

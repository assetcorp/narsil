import {
  EF_SEARCH,
  HNSW_EF_CONSTRUCTION,
  HNSW_M,
  HYBRID_MEASURED_PASSES,
  INSERT_BATCH_DOCUMENTS,
  KEYWORD_MEASURED_PASSES,
  RECALL_DEPTH,
  RESULT_LIMIT,
  RRF_RANK_CONSTANT,
  SMALL_MEASURED_PASSES,
  SMALL_WARMUP_PASSES,
  VECTOR_MEASURED_PASSES,
  VECTOR_PROMOTION_THRESHOLD,
  WARMUP_PASSES,
  WORKER_PROMOTION_THRESHOLD,
} from '../constants'
import type { WorkloadSettings } from './format'

export type WorkloadSize = 'full' | 'small'

export function workloadSettings(size: WorkloadSize): WorkloadSettings {
  const small = size === 'small'
  return {
    language: 'english',
    limit: RESULT_LIMIT,
    recallDepth: RECALL_DEPTH,
    hybridLegDepth: RESULT_LIMIT + 1,
    efSearch: EF_SEARCH,
    hnswM: HNSW_M,
    hnswEfConstruction: HNSW_EF_CONSTRUCTION,
    vectorThreshold: VECTOR_PROMOTION_THRESHOLD,
    quantization: 'none',
    metric: 'cosine',
    rrfK: RRF_RANK_CONSTANT,
    insertBatch: INSERT_BATCH_DOCUMENTS,
    workerPromotionThreshold: WORKER_PROMOTION_THRESHOLD,
    warmupPasses: small ? SMALL_WARMUP_PASSES : WARMUP_PASSES,
    measuredPasses: small
      ? { keyword: SMALL_MEASURED_PASSES, vector: SMALL_MEASURED_PASSES, hybrid: SMALL_MEASURED_PASSES }
      : { keyword: KEYWORD_MEASURED_PASSES, vector: VECTOR_MEASURED_PASSES, hybrid: HYBRID_MEASURED_PASSES },
  }
}

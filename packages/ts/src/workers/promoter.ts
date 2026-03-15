export interface ExecutionPromoterConfig {
  perIndexThreshold?: number
  totalThreshold?: number
}

export interface PromotionCheck {
  shouldPromote: boolean
  reason: string
}

export interface ExecutionPromoter {
  check(indexes: Map<string, { documentCount: number }>): PromotionCheck
  markPromoted(): void
  isPromoted(): boolean
}

const DEFAULT_PER_INDEX_THRESHOLD = 10_000
const DEFAULT_TOTAL_THRESHOLD = 50_000

export function createExecutionPromoter(config?: ExecutionPromoterConfig): ExecutionPromoter {
  const perIndexThreshold = config?.perIndexThreshold ?? DEFAULT_PER_INDEX_THRESHOLD
  const totalThreshold = config?.totalThreshold ?? DEFAULT_TOTAL_THRESHOLD
  let promoted = false

  function check(indexes: Map<string, { documentCount: number }>): PromotionCheck {
    if (promoted) {
      return { shouldPromote: false, reason: '' }
    }

    let totalDocuments = 0

    for (const [indexName, stats] of indexes) {
      if (stats.documentCount >= perIndexThreshold) {
        return {
          shouldPromote: true,
          reason: `Index "${indexName}" has ${stats.documentCount} documents, exceeding the per-index threshold of ${perIndexThreshold}`,
        }
      }
      totalDocuments += stats.documentCount
    }

    if (totalDocuments >= totalThreshold) {
      return {
        shouldPromote: true,
        reason: `Total document count of ${totalDocuments} exceeds the total threshold of ${totalThreshold}`,
      }
    }

    return { shouldPromote: false, reason: '' }
  }

  function markPromoted(): void {
    promoted = true
  }

  function isPromoted(): boolean {
    return promoted
  }

  return { check, markPromoted, isPromoted }
}

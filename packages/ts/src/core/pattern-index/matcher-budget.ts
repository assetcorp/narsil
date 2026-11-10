import { MATCHER_STATE_BUDGET_BYTES } from '#platform/worker-copies-host'

export function widestPatternSplit(footprintBytes: number): number {
  return Math.max(1, Math.floor(MATCHER_STATE_BUDGET_BYTES / Math.max(1, footprintBytes)))
}

import type { PartitionStatsResult } from '../types/results'

export interface IndexStoredSizes {
  readonly savedBytes: number | undefined
  readonly logBytes: number | undefined
  readonly vectorSavedBytes: number | undefined
  addTo(stats: PartitionStatsResult[]): void
  recordSavedBytes(bytes: number | undefined): void
}

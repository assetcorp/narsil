export const WIRE_BATCH_BUDGET = {
  maxCount: 1_000,
  maxBytes: 8_388_608,
  overheadBytes: 256,
} as const

export const MAX_PARTITION_COUNT = 65_536
export const MAX_REPLICATION_FACTOR = 255

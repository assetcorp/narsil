export const SNAPSHOT_CHUNK_SIZE = 65_536

export const MAX_SNAPSHOT_SIZE_BYTES = 2 * 1024 * 1024 * 1024

/**
 * Sentinel lastSeqNo emitted by the cluster-node bootstrap path because that
 * path produces a whole-index engine snapshot, not a per-partition replication
 * checkpoint. The live-replication path in sync-primary carries a real seqNo.
 * Replicas receiving the sentinel must not treat it as an ordering anchor.
 * Chosen to fit inside Number.MAX_SAFE_INTEGER while remaining unambiguously
 * out-of-band relative to any realistic operational value.
 */
export const SNAPSHOT_HEADER_SENTINEL_SEQNO = Number.MAX_SAFE_INTEGER

/**
 * Sentinel partitionId emitted by the cluster-node bootstrap path to mark a
 * whole-index snapshot. The live-replication path carries the real partitionId.
 */
export const SNAPSHOT_HEADER_SENTINEL_PARTITION_ID = 0xffff_ffff

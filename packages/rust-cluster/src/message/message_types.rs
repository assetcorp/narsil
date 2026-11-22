/// A health check, which any node answers with a `cluster.pong`.
pub const CLUSTER_PING: &str = "cluster.ping";
/// The answer to a `cluster.ping`.
pub const CLUSTER_PONG: &str = "cluster.pong";
/// A client mutation that another node forwards to the partition's primary.
pub const REPLICATION_FORWARD: &str = "replication.forward";
/// Many client mutations that another node forwards to a primary of their partitions.
pub const REPLICATION_FORWARD_BATCH: &str = "replication.forward_batch";
/// A read of named documents from the copies that a node holds.
pub const QUERY_FETCH: &str = "query.fetch";
/// The answer to a `query.fetch`.
pub const QUERY_FETCH_RESULT: &str = "query.fetch_result";
/// A replication log entry from a primary.
pub const REPLICATION_ENTRY: &str = "replication.entry";
/// Contiguous replication log entries from a primary.
pub const REPLICATION_ENTRY_BATCH: &str = "replication.entry_batch";
/// The start of a new primary term.
pub const REPLICATION_TERM_START: &str = "replication.term_start";
/// A copy's answer to the start of a term, with its highest entry.
pub const REPLICATION_TERM_START_ACK: &str = "replication.term_start_ack";
/// A replica's acknowledgement of replication log entries.
pub const REPLICATION_ACK: &str = "replication.ack";
/// A replica's request that the primary send what its copy of a partition lacks, or its report of the position
/// that a sync left it at.
pub const REPLICATION_SYNC_REQUEST: &str = "replication.sync_request";
/// A batch of log entries in the primary's answer to a sync request.
pub const REPLICATION_SYNC_ENTRIES: &str = "replication.sync_entries";
/// The start of a snapshot transfer from a primary, carrying the snapshot header.
pub const REPLICATION_SNAPSHOT_START: &str = "replication.snapshot_start";
/// One streamed chunk of a snapshot transfer.
pub const REPLICATION_SNAPSHOT_CHUNK: &str = "replication.snapshot_chunk";
/// The end of a snapshot transfer.
pub const REPLICATION_SNAPSHOT_END: &str = "replication.snapshot_end";
/// A primary's request that the controller admit a caught-up replica to the in-sync set.
pub const REPLICATION_INSYNC_ADD: &str = "replication.insync_add";
/// A request that the controller drop a replica from the in-sync set.
pub const REPLICATION_INSYNC_REMOVE: &str = "replication.insync_remove";
/// The controller's answer to an in-sync change or a primary's resignation.
pub const REPLICATION_INSYNC_CONFIRM: &str = "replication.insync_confirm";
/// A primary's request that the controller hand its partition to another node.
pub const REPLICATION_PRIMARY_RESIGN: &str = "replication.primary_resign";
/// The first phase of a search, which names the partitions to search.
pub const QUERY_SEARCH: &str = "query.search";
/// The answer to a `query.search`, with scored document ids and facet counts.
pub const QUERY_SEARCH_RESULT: &str = "query.search_result";
/// A request for the term statistics of named partitions, which a distributed-frequency search sends first.
pub const QUERY_STATS: &str = "query.stats";
/// The answer to a `query.stats`.
pub const QUERY_STATS_RESULT: &str = "query.stats_result";
/// A request for the document count of each named partition.
pub const QUERY_COUNT: &str = "query.count";
/// The answer to a `query.count`.
pub const QUERY_COUNT_RESULT: &str = "query.count_result";
/// A request for one page of stored documents from named partitions.
pub const QUERY_LIST: &str = "query.list";
/// The answer to a `query.list`.
pub const QUERY_LIST_RESULT: &str = "query.list_result";
/// A request for the completions of a prefix from named partitions.
pub const QUERY_SUGGEST: &str = "query.suggest";
/// The answer to a `query.suggest`.
pub const QUERY_SUGGEST_RESULT: &str = "query.suggest_result";
/// A request for the match count of a query over named partitions.
pub const QUERY_PREFLIGHT: &str = "query.preflight";
/// The answer to a `query.preflight`.
pub const QUERY_PREFLIGHT_RESULT: &str = "query.preflight_result";
/// A primary's report that its copy of a partition is ready, and the controller's answer to it.
pub const CLUSTER_BOOTSTRAP_COMPLETE: &str = "cluster.bootstrap_complete";
/// The controller's question of which partitions a node's local copy holds, and the node's answer.
pub const CLUSTER_PARTITION_STORES: &str = "cluster.partition_stores";
/// A request that the controller change the replication factor of an index.
pub const CLUSTER_REPLICATION_FACTOR: &str = "cluster.replication_factor";
/// A request that a data node rebuild the terms of every copy of an index that it holds.
pub const CLUSTER_REBUILD_ANALYSIS: &str = "cluster.rebuild_analysis";
/// A request that the controller change the partition count of an index.
pub const CLUSTER_REBALANCE: &str = "cluster.rebalance";
/// The controller's request that a primary start or resume copying one partition into a new generation.
pub const CLUSTER_RESHARD_START: &str = "cluster.reshard_start";
/// Documents and removals that one primary copies into a new generation on another.
pub const CLUSTER_RESHARD_FORWARD: &str = "cluster.reshard_forward";
/// The controller's request that a primary block or lift writes for a partition count cutover.
pub const CLUSTER_RESHARD_CUTOVER: &str = "cluster.reshard_cutover";
/// A primary's request that another remove one old partition's documents from a new generation.
pub const CLUSTER_RESHARD_PURGE: &str = "cluster.reshard_purge";
/// A request that the controller take a backup of an index.
pub const CLUSTER_BACKUP: &str = "cluster.backup";
/// A request that the controller restore an index from a backup.
pub const CLUSTER_BACKUP_RESTORE: &str = "cluster.backup_restore";
/// A request that the controller delete a backup.
pub const CLUSTER_BACKUP_DELETE: &str = "cluster.backup_delete";
/// The controller's request that a primary save one partition of a backup.
pub const CLUSTER_BACKUP_PARTITION: &str = "cluster.backup_partition";
/// The controller's request that a primary load one partition of a restore.
pub const CLUSTER_RESTORE_PARTITION: &str = "cluster.restore_partition";
/// A request that a data node apply the synonym set that the coordinator holds for an index.
pub const CLUSTER_INDEX_SETTINGS: &str = "cluster.index_settings";
/// A read of the entries of one partition for a device feed or a change feed.
pub const SYNC_READ: &str = "sync.read";
/// A stream of the query counts of one index that a node holds.
pub const SUGGESTIONS_COUNTS: &str = "suggestions.counts";
/// A request that the controller build the query suggestions of an index.
pub const SUGGESTIONS_BUILD: &str = "suggestions.build";

const SPECIFIED: [&str; 50] = [
    CLUSTER_PING,
    CLUSTER_PONG,
    REPLICATION_FORWARD,
    REPLICATION_FORWARD_BATCH,
    QUERY_FETCH,
    QUERY_FETCH_RESULT,
    REPLICATION_ENTRY,
    REPLICATION_ENTRY_BATCH,
    REPLICATION_TERM_START,
    REPLICATION_TERM_START_ACK,
    REPLICATION_ACK,
    REPLICATION_SYNC_REQUEST,
    REPLICATION_SYNC_ENTRIES,
    REPLICATION_SNAPSHOT_START,
    REPLICATION_SNAPSHOT_CHUNK,
    REPLICATION_SNAPSHOT_END,
    REPLICATION_INSYNC_ADD,
    REPLICATION_INSYNC_REMOVE,
    REPLICATION_INSYNC_CONFIRM,
    REPLICATION_PRIMARY_RESIGN,
    QUERY_SEARCH,
    QUERY_SEARCH_RESULT,
    QUERY_STATS,
    QUERY_STATS_RESULT,
    QUERY_COUNT,
    QUERY_COUNT_RESULT,
    QUERY_LIST,
    QUERY_LIST_RESULT,
    QUERY_SUGGEST,
    QUERY_SUGGEST_RESULT,
    QUERY_PREFLIGHT,
    QUERY_PREFLIGHT_RESULT,
    CLUSTER_BOOTSTRAP_COMPLETE,
    CLUSTER_PARTITION_STORES,
    CLUSTER_REPLICATION_FACTOR,
    CLUSTER_REBUILD_ANALYSIS,
    CLUSTER_REBALANCE,
    CLUSTER_RESHARD_START,
    CLUSTER_RESHARD_FORWARD,
    CLUSTER_RESHARD_CUTOVER,
    CLUSTER_RESHARD_PURGE,
    CLUSTER_BACKUP,
    CLUSTER_BACKUP_RESTORE,
    CLUSTER_BACKUP_DELETE,
    CLUSTER_BACKUP_PARTITION,
    CLUSTER_RESTORE_PARTITION,
    CLUSTER_INDEX_SETTINGS,
    SYNC_READ,
    SUGGESTIONS_COUNTS,
    SUGGESTIONS_BUILD,
];

pub(crate) fn is_specified(message_type: &str) -> bool {
    SPECIFIED.contains(&message_type)
}

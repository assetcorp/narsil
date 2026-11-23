use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;

use narsil::{EmbeddingAdapter, NarsilConfig, RerankAdapter, StopWords, Tokenizer};

use crate::constants::DEFAULT_LOG_RETENTION_BYTES;

/// The settings that a node with the `data` role keeps its copies of partitions with.
#[derive(Clone)]
pub struct DataNodeConfig {
    /// What the node opens its local engine with as it joins. The node closes that engine as it leaves, and no
    /// other engine may hold the same directory meanwhile.
    pub engine: NarsilConfig,
    /// The tokenizers that the node registers on its local engine under these names before the engine recovers a
    /// stored copy, so that a copy of an index whose settings give a tokenizer by name analyses text with it.
    pub tokenizers: BTreeMap<String, Arc<dyn Tokenizer>>,
    /// The stop word sets that the node registers on its local engine under these names before the engine
    /// recovers a stored copy, so that a copy of an index whose settings give a stop word set by name drops them.
    pub stop_words: BTreeMap<String, StopWords>,
    /// The embedding adapters that the node registers on its local engine under these names before the engine
    /// recovers a stored copy, so that a copy of an index whose settings give an adapter by name embeds with it.
    pub embedding_adapters: BTreeMap<String, Arc<dyn EmbeddingAdapter>>,
    /// The rerank adapters that the node registers on its local engine under these names before the engine
    /// recovers a stored copy, so that a query on a local copy can rerank with an adapter that it gives by name.
    pub rerank_adapters: BTreeMap<String, Arc<dyn RerankAdapter>>,
    /// The most bytes of replication log entries that the node keeps in memory for each partition, which is
    /// `logRetentionBytes` in `replication.md`. The node drops the oldest entries past it, so a replica that lacks a
    /// dropped entry cannot catch up from this log, and a primary refuses with `REPLICATION_LOG_FULL` a write whose
    /// single entry passes it. It must be at least 1.
    pub log_retention_bytes: u64,
}

impl DataNodeConfig {
    /// Returns the settings of a data node whose local engine opens with `engine`, that holds no named tokenizer,
    /// stop word set, or adapter, and that keeps the default 268,435,456 bytes of replication log for each partition.
    ///
    /// The node writes each snapshot in transfer to `.snapshot-transfer` under the engine's durability directory,
    /// which it empties as it joins, or to a new directory under the system's temporary directory where the engine
    /// keeps no directory.
    ///
    /// A copy of an index whose settings give one of those by name then fails to create with the engine's
    /// `CONFIG_INVALID`, so add each name that the cluster's indexes give before the node joins.
    pub fn new(engine: NarsilConfig) -> DataNodeConfig {
        DataNodeConfig {
            engine,
            tokenizers: BTreeMap::new(),
            stop_words: BTreeMap::new(),
            embedding_adapters: BTreeMap::new(),
            rerank_adapters: BTreeMap::new(),
            log_retention_bytes: DEFAULT_LOG_RETENTION_BYTES,
        }
    }
}

impl fmt::Debug for DataNodeConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DataNodeConfig")
            .field("engine", &self.engine)
            .field("tokenizers", &self.tokenizers.keys().collect::<Vec<_>>())
            .field("stop_words", &self.stop_words.keys().collect::<Vec<_>>())
            .field(
                "embedding_adapters",
                &self.embedding_adapters.keys().collect::<Vec<_>>(),
            )
            .field(
                "rerank_adapters",
                &self.rerank_adapters.keys().collect::<Vec<_>>(),
            )
            .field("log_retention_bytes", &self.log_retention_bytes)
            .finish()
    }
}

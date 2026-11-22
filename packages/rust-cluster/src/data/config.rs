use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;

use narsil::{EmbeddingAdapter, NarsilConfig, RerankAdapter, StopWords, Tokenizer};

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
}

impl DataNodeConfig {
    /// Returns the settings of a data node whose local engine opens with `engine` and holds no named tokenizer,
    /// stop word set, or adapter.
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
            .finish()
    }
}

use std::collections::BTreeMap;
use std::sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard};

use super::rerank_settings::RerankSettings;
use crate::adapters::{EmbeddingAdapter, RerankAdapter};

/// The embedding adapters of an engine, keyed by the name that an index configuration gives.
pub(crate) type EmbeddingAdapters = BTreeMap<String, Arc<dyn EmbeddingAdapter>>;

/// The rerank adapters of an engine, keyed by the name that a query gives.
pub(crate) type RerankAdapters = BTreeMap<String, Arc<dyn RerankAdapter>>;

/// The adapters that an engine holds by name, which every index of the engine shares.
#[derive(Default)]
pub(crate) struct AdapterRegistry {
    embedding: RwLock<EmbeddingAdapters>,
    rerank: RwLock<RerankAdapters>,
    rerank_settings: RerankSettings,
}

impl AdapterRegistry {
    /// Returns an empty registry whose rerank calls follow `rerank_settings`.
    pub(crate) fn with_rerank(rerank_settings: RerankSettings) -> AdapterRegistry {
        AdapterRegistry {
            rerank_settings,
            ..AdapterRegistry::default()
        }
    }

    /// Returns how long a rerank call may take and the most hits that one query may rerank.
    pub(crate) fn rerank_settings(&self) -> RerankSettings {
        self.rerank_settings
    }

    pub(crate) fn embedding(&self) -> RwLockReadGuard<'_, EmbeddingAdapters> {
        self.embedding
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn embedding_mut(&self) -> RwLockWriteGuard<'_, EmbeddingAdapters> {
        self.embedding
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Returns the embedding adapter registered under `name` as it stands now.
    pub(crate) fn embedding_adapter(&self, name: &str) -> Option<Arc<dyn EmbeddingAdapter>> {
        self.embedding().get(name).cloned()
    }

    pub(crate) fn rerank(&self) -> RwLockReadGuard<'_, RerankAdapters> {
        self.rerank
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn rerank_mut(&self) -> RwLockWriteGuard<'_, RerankAdapters> {
        self.rerank
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn clear(&self) {
        self.embedding_mut().clear();
        self.rerank_mut().clear();
    }
}

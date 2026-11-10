use std::sync::Arc;

use super::{Narsil, VectorMaintenanceStatus, durable, registration, synonyms};
use crate::adapters::{EmbeddingAdapter, RerankAdapter};
use crate::analysis::{StopWords, Tokenizer};
use crate::config::SynonymRule;
use crate::error::Result;

impl Narsil {
    /// Registers a tokenizer under `name`, so that an index configuration can name it.
    pub fn register_tokenizer(&self, name: &str, tokenizer: Arc<dyn Tokenizer>) -> Result<()> {
        self.inner.analysis.register_tokenizer(name, tokenizer)
    }

    /// Registers a stop word set or function under `name`, so that an index configuration can name it.
    pub fn register_stop_words(&self, name: &str, stop_words: StopWords) -> Result<()> {
        self.inner.analysis.register_stop_words(name, stop_words)
    }

    /// Registers an embedding adapter under `name`, so that an index configuration can give the name, and a later
    /// restart of a durable engine finds the adapter by it.
    ///
    /// A name that is taken already moves every index that gives it to the new adapter. The engine first checks
    /// the new adapter's dimensions against every vector field that those indexes embed, and on a mismatch fails
    /// with `EMBEDDING_DIMENSION_MISMATCH` and leaves the old adapter in place.
    pub fn register_embedding_adapter(
        &self,
        name: &str,
        adapter: Arc<dyn EmbeddingAdapter>,
    ) -> Result<()> {
        registration::register_embedding_adapter(&self.inner, name, adapter)
    }

    /// Registers a rerank adapter under `name`, which a query's [`super::RerankConfig::adapter`] then gives.
    pub fn register_rerank_adapter(
        &self,
        name: &str,
        adapter: Arc<dyn RerankAdapter>,
    ) -> Result<()> {
        registration::register_rerank_adapter(&self.inner, name, adapter)
    }

    /// Writes the index's current state to the durability store, so that a restart replays less of the log; an
    /// engine without durability does nothing.
    pub fn checkpoint(&self, index: &str) -> Result<()> {
        let outcome = durable::checkpoint_now(&*self.inner.open_index(index)?);
        if let Some(durable) = &self.inner.durable {
            durable.request_pass();
        }
        outcome
    }

    /// Replaces the synonym set of an index, so that each later search also matches the synonyms of its terms; an
    /// empty list removes the set.
    ///
    /// Fails with `CONFIG_INVALID` where a rule breaks a limit or holds a word that the index analyses to no token
    /// or to several, and leaves the old set in place.
    pub fn update_synonyms(&self, index: &str, rules: &[SynonymRule]) -> Result<()> {
        self.inner
            .on_current_index(index, |state| synonyms::update_synonyms(state, rules))
    }

    /// Returns the synonym set of an index, or an empty list where it holds none.
    pub fn get_synonyms(&self, index: &str) -> Result<Vec<SynonymRule>> {
        Ok(synonyms::synonym_rules(&*self.inner.open_index(index)?))
    }

    /// Takes the vectors that removals and updates left behind out of every vector field of the index, or out of
    /// `field` alone, in a time that grows with the number of such vectors.
    ///
    /// Fails with `INDEX_NOT_FOUND` where the index holds no vector field at `field`.
    pub fn compact_vectors(&self, index: &str, field: Option<&str>) -> Result<()> {
        let state = self.inner.open_index(index)?;
        let outcome = state.vectors.compact(&state.name, field);
        self.inner.events.wrote(&state.name);
        outcome
    }

    /// Folds every vector that waits outside the graph into the graph of each vector field of the index, or of
    /// `field` alone, rebuilding a graph that removals have thinned, and returns once the work is done.
    ///
    /// Fails with `INDEX_NOT_FOUND` where the index holds no vector field at `field`.
    pub fn optimize_vectors(&self, index: &str, field: Option<&str>) -> Result<()> {
        let state = self.inner.open_index(index)?;
        let outcome = state.vectors.optimize(&state.name, field);
        self.inner.events.wrote(&state.name);
        outcome
    }

    /// Returns the upkeep state of each vector field of the index, in schema order.
    pub fn vector_maintenance_status(&self, index: &str) -> Result<Vec<VectorMaintenanceStatus>> {
        Ok(self.inner.open_index(index)?.vectors.maintenance_status())
    }
}

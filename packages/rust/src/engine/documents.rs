use std::collections::BTreeMap;
use std::sync::Arc;

use super::constants::MAX_REPLACED_WRITE_ATTEMPTS;
use super::hooked;
use super::index::IndexState;
use super::writes::BatchFailure;
use super::{BatchResult, Narsil, QueryParams, QueryResult, query, reads, writes};
use crate::error::Result;
use crate::value::Map;

impl Narsil {
    fn attempt_write<T>(
        &self,
        index: &str,
        write: impl FnOnce(&IndexState) -> Result<T>,
    ) -> Result<(Arc<IndexState>, Result<T>)> {
        let writable = self.inner.writable_index(index)?;
        let state = Arc::clone(writable.index());
        let outcome = write(&state);
        self.inner.after_write(&state);
        drop(writable);
        Ok((state, outcome))
    }

    /// Runs one document write against the index, which a close of the index waits for, and runs it again against
    /// the index that took its name where a restore or a close retired the index while the write waited.
    fn write_one<T>(
        &self,
        index: &str,
        mut write: impl FnMut(&IndexState) -> Result<T>,
    ) -> Result<T> {
        let mut attempt = 1;
        loop {
            let (state, outcome) = self.attempt_write(index, &mut write)?;
            if outcome.is_err() && state.is_retired() && attempt < MAX_REPLACED_WRITE_ATTEMPTS {
                attempt += 1;
                continue;
            }
            self.wrote(&state);
            return outcome;
        }
    }

    fn wrote(&self, state: &IndexState) {
        self.inner.events.wrote(&state.name);
        self.inner.events.check_watermark(state);
    }

    fn write_batch(
        &self,
        index: &str,
        write: impl FnOnce(&IndexState) -> Result<BatchResult>,
    ) -> Result<BatchResult> {
        let (state, outcome) = self.attempt_write(index, write)?;
        self.wrote(&state);
        outcome
    }

    /// Inserts `document` and returns its ID: `doc_id` where given, else the document's string `id` field, else the
    /// ID that the engine's ID generator gives, which is a new UUID version 7 by default.
    ///
    /// Fails with `MEMORY_WRITE_BLOCKED` while process memory stays above the engine's block fraction.
    pub fn insert(&self, index: &str, document: Map, doc_id: Option<&str>) -> Result<String> {
        self.inner.refuse_while_memory_full(index)?;
        let next_id = || self.inner.next_document_id();
        let plugins = &self.inner.plugins;
        if plugins.is_empty() {
            let mut held = Some(document);
            return self.write_one(index, |state| {
                writes::insert(state, &mut held, doc_id, &next_id)
            });
        }
        let name = self.inner.open_index(index)?.name.clone();
        let mut document = document;
        let id = hooked::before_insert(plugins, &name, &mut document, doc_id, &next_id)?;
        let kept = document.clone();
        let mut held = Some(document);
        let id = self.write_one(index, |state| {
            writes::insert(state, &mut held, Some(&id), &next_id)
        })?;
        plugins.after(|plugin| plugin.after_insert(&name, &id, &kept));
        Ok(id)
    }

    /// Inserts many documents, refusing each bad document alone, so one failure leaves the rest written.
    ///
    /// Fails with `MEMORY_WRITE_BLOCKED` while process memory stays above the engine's block fraction.
    pub fn insert_batch(&self, index: &str, documents: Vec<Map>) -> Result<BatchResult> {
        self.inner.refuse_while_memory_full(index)?;
        let next_id = || self.inner.next_document_id();
        let plugins = &self.inner.plugins;
        if plugins.is_empty() {
            return self.write_batch(index, |state| {
                writes::insert_batch(state, documents, Vec::new(), &next_id)
            });
        }
        let state = self.inner.open_index(index)?;
        let hooked = hooked::before_insert_batch(plugins, &state.name, documents, &next_id);
        let mut result = self.write_batch(index, |state| {
            writes::insert_batch(state, hooked.documents, hooked.ids, &next_id)
        })?;
        hooked::after_insert_batch(
            plugins,
            &state.name,
            hooked.kept,
            hooked.failed,
            &mut result,
        );
        Ok(result)
    }

    /// Replaces the document stored under `doc_id`, failing with `DOC_NOT_FOUND` where the index holds none.
    ///
    /// Fails with `MEMORY_WRITE_BLOCKED` while process memory stays above the engine's block fraction.
    pub fn update(&self, index: &str, doc_id: &str, document: Map) -> Result<()> {
        self.inner.refuse_while_memory_full(index)?;
        let plugins = &self.inner.plugins;
        if plugins.is_empty() {
            let mut held = Some(document);
            return self.write_one(index, |state| writes::update(state, doc_id, &mut held));
        }
        let state = self.inner.open_index(index)?;
        let mut document = document;
        let old = hooked::before_update(plugins, &state, doc_id, &mut document)?;
        let kept = document.clone();
        let mut held = Some(document);
        self.write_one(index, |state| writes::update(state, doc_id, &mut held))?;
        plugins.after(|plugin| plugin.after_update(&state.name, doc_id, &old, &kept));
        Ok(())
    }

    /// Replaces many documents, each given with its ID, refusing each bad update alone.
    ///
    /// Fails with `MEMORY_WRITE_BLOCKED` while process memory stays above the engine's block fraction.
    pub fn update_batch(&self, index: &str, updates: Vec<(String, Map)>) -> Result<BatchResult> {
        self.inner.refuse_while_memory_full(index)?;
        let plugins = &self.inner.plugins;
        if plugins.is_empty() {
            return self.write_batch(index, |state| writes::update_batch(state, updates));
        }
        let state = self.inner.open_index(index)?;
        let mut admitted = Vec::with_capacity(updates.len());
        let mut kept = Vec::with_capacity(updates.len());
        let mut failed = Vec::new();
        for (doc_id, mut document) in updates {
            match hooked::before_update(plugins, &state, &doc_id, &mut document) {
                Ok(old) => {
                    kept.push((doc_id.clone(), old, document.clone()));
                    admitted.push((doc_id, document));
                }
                Err(error) => failed.push(BatchFailure { doc_id, error }),
            }
        }
        let mut result = self.write_batch(index, |state| writes::update_batch(state, admitted))?;
        let mut written = result.succeeded.iter().peekable();
        for (doc_id, old, new) in kept {
            if written.next_if(|id| **id == doc_id).is_some() {
                plugins.after(|plugin| plugin.after_update(&state.name, &doc_id, &old, &new));
            }
        }
        hooked::add_refusals(failed, &mut result);
        Ok(result)
    }

    /// Removes the document stored under `doc_id`, failing with `DOC_NOT_FOUND` where the index holds none.
    pub fn remove(&self, index: &str, doc_id: &str) -> Result<()> {
        let plugins = &self.inner.plugins;
        if plugins.is_empty() {
            self.write_one(index, |state| writes::remove(state, doc_id))?;
            self.inner.memory.memory_released();
            return Ok(());
        }
        let name = self.inner.open_index(index)?.name.clone();
        hooked::before_remove(plugins, &name, doc_id)?;
        self.write_one(index, |state| writes::remove(state, doc_id))?;
        self.inner.memory.memory_released();
        plugins.after(|plugin| plugin.after_remove(&name, doc_id));
        Ok(())
    }

    /// Removes many documents, refusing each missing ID alone.
    pub fn remove_batch(&self, index: &str, doc_ids: Vec<String>) -> Result<BatchResult> {
        let result = self.remove_batch_hooked(index, doc_ids)?;
        if !result.succeeded.is_empty() {
            self.inner.memory.memory_released();
        }
        Ok(result)
    }

    fn remove_batch_hooked(&self, index: &str, doc_ids: Vec<String>) -> Result<BatchResult> {
        let plugins = &self.inner.plugins;
        if plugins.is_empty() {
            return self.write_batch(index, |state| writes::remove_batch(state, doc_ids));
        }
        let state = self.inner.open_index(index)?;
        let mut admitted = Vec::with_capacity(doc_ids.len());
        let mut failed = Vec::new();
        for doc_id in doc_ids {
            match hooked::before_remove(plugins, &state.name, &doc_id) {
                Ok(()) => admitted.push(doc_id),
                Err(error) => failed.push(BatchFailure { doc_id, error }),
            }
        }
        let mut result = self.write_batch(index, |state| writes::remove_batch(state, admitted))?;
        for doc_id in &result.succeeded {
            plugins.after(|plugin| plugin.after_remove(&state.name, doc_id));
        }
        hooked::add_refusals(failed, &mut result);
        Ok(result)
    }

    /// Returns the document stored under `doc_id`, or `None` where the index holds none.
    pub fn get(&self, index: &str, doc_id: &str) -> Result<Option<Map>> {
        reads::get(&*self.inner.open_index(index)?, doc_id)
    }

    /// Returns the documents stored under each of `doc_ids` that the index holds, keyed by ID.
    pub fn get_multiple(&self, index: &str, doc_ids: &[String]) -> Result<BTreeMap<String, Map>> {
        reads::get_multiple(&*self.inner.open_index(index)?, doc_ids)
    }

    /// Reports whether the index holds a document under `doc_id`.
    pub fn has(&self, index: &str, doc_id: &str) -> Result<bool> {
        reads::has(&*self.inner.open_index(index)?, doc_id)
    }

    /// Returns the number of documents in the index.
    pub fn count_documents(&self, index: &str) -> Result<u64> {
        Ok(self.inner.open_index(index)?.document_count())
    }

    /// Runs a query against the index and returns a page of hits, best first.
    ///
    /// Every [`crate::Plugin::before_search`] hook runs first and can rewrite or refuse the query, and every
    /// [`crate::Plugin::after_search`] hook then sees the query that ran and its result.
    pub fn query(&self, index: &str, params: &QueryParams) -> Result<QueryResult> {
        let state = self.inner.open_index(index)?;
        let plugins = &self.inner.plugins;
        let work_cap = self.inner.pattern_work_cap;
        if plugins.is_empty() {
            return query::run_query(&state, params, work_cap);
        }
        let mut scoped = params.clone();
        plugins.before_search(&state.name, &mut scoped)?;
        let result = query::run_query(&state, &scoped, work_cap)?;
        plugins.after(|plugin| plugin.after_search(&state.name, &scoped, &result));
        Ok(result)
    }
}

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, RwLock};

use super::Narsil;
use super::callback_scope::CallbackScope;
use super::query::params::QueryParams;
use super::query::results::QueryResult;
use crate::config::IndexConfig;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::value::Map;

/// Hooks that the engine calls alongside its own work, so that an application can add validation, auditing,
/// enrichment, or metrics without forking the engine.
///
/// Every hook does nothing unless the plugin overrides it. A `before` hook runs first and refuses the operation by
/// returning an error, which the engine passes to the caller unchanged, and the engine refuses the operation with
/// `DOC_VALIDATION_FAILED` where a `before` hook of a write panics, and with `HOOK_ERROR` where
/// [`Plugin::before_search`] panics. An `after` hook runs once the operation succeeds, and the engine ignores a
/// panic inside it, because the operation is already over. The engine holds none of its locks while a hook runs,
/// so a hook may call the engine, and slow work inside a hook slows every write or search that it covers.
pub trait Plugin: Send + Sync {
    /// Returns the name that identifies the plugin in the errors that the engine raises for it.
    fn name(&self) -> &str;

    /// Runs before the engine indexes `document` under `doc_id`, which the engine resolves first, and the engine
    /// indexes whatever the hook leaves in `document`.
    fn before_insert(&self, index_name: &str, doc_id: &str, document: &mut Map) -> Result<()> {
        let _ = (index_name, doc_id, document);
        Ok(())
    }

    /// Runs once the engine has indexed `document` under `doc_id`.
    fn after_insert(&self, index_name: &str, doc_id: &str, document: &Map) {
        let _ = (index_name, doc_id, document);
    }

    /// Runs before the engine replaces the document under `doc_id`, with the document that the index holds now,
    /// or an empty map where it holds none, and the engine indexes whatever the hook leaves in `new_document`.
    fn before_update(
        &self,
        index_name: &str,
        doc_id: &str,
        old_document: &Map,
        new_document: &mut Map,
    ) -> Result<()> {
        let _ = (index_name, doc_id, old_document, new_document);
        Ok(())
    }

    /// Runs once the engine has replaced `old_document` with `new_document` under `doc_id`.
    fn after_update(&self, index_name: &str, doc_id: &str, old_document: &Map, new_document: &Map) {
        let _ = (index_name, doc_id, old_document, new_document);
    }

    /// Runs before the engine removes the document under `doc_id`.
    fn before_remove(&self, index_name: &str, doc_id: &str) -> Result<()> {
        let _ = (index_name, doc_id);
        Ok(())
    }

    /// Runs once the engine has removed the document under `doc_id`.
    fn after_remove(&self, index_name: &str, doc_id: &str) {
        let _ = (index_name, doc_id);
    }

    /// Runs before every query, before the engine embeds the text of a vector clause, and the engine runs the
    /// query that the hook leaves in `params`.
    fn before_search(&self, index_name: &str, params: &mut QueryParams) -> Result<()> {
        let _ = (index_name, params);
        Ok(())
    }

    /// Runs once a query returns `result`, which the caller receives unchanged.
    fn after_search(&self, index_name: &str, params: &QueryParams, result: &QueryResult) {
        let _ = (index_name, params, result);
    }

    /// Runs once the engine creates an index with `config`.
    fn on_index_create(&self, index_name: &str, config: &IndexConfig) {
        let _ = (index_name, config);
    }

    /// Runs once the engine drops an index that held `config`.
    fn on_index_drop(&self, index_name: &str, config: &IndexConfig) {
        let _ = (index_name, config);
    }

    /// Runs once [`Narsil::rebalance`] moves an index from `old_count` partitions onto `new_count`.
    fn on_partition_split(&self, index_name: &str, old_count: usize, new_count: usize) {
        let _ = (index_name, old_count, new_count);
    }
}

/// The hook of a write that a `before` hook refuses when it panics.
#[derive(Clone, Copy)]
pub(crate) enum WriteHook {
    Insert,
    Update,
    Remove,
}

impl WriteHook {
    fn label(self) -> &'static str {
        match self {
            WriteHook::Insert => "beforeInsert",
            WriteHook::Update => "beforeUpdate",
            WriteHook::Remove => "beforeRemove",
        }
    }
}

/// The plugins of one engine, in the order that the caller added them.
#[derive(Default)]
pub(crate) struct PluginRegistry {
    plugins: RwLock<Vec<Arc<dyn Plugin>>>,
}

impl PluginRegistry {
    fn current(&self) -> Vec<Arc<dyn Plugin>> {
        self.plugins
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Reports whether the engine holds no plugin, so that a write skips the copies that its hooks need.
    pub(crate) fn is_empty(&self) -> bool {
        self.plugins
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_empty()
    }

    fn refuse(
        &self,
        panicked: ErrorCode,
        label: &str,
        mut hook: impl FnMut(&dyn Plugin) -> Result<()>,
    ) -> Result<()> {
        let _scope = CallbackScope::enter(self);
        for plugin in self.current() {
            match catch_unwind(AssertUnwindSafe(|| hook(plugin.as_ref()))) {
                Ok(outcome) => outcome?,
                Err(_) => {
                    return Err(NarsilError::new(
                        panicked,
                        format!(
                            "The {label} hook of plugin \"{}\" rejects the call",
                            plugin.name()
                        ),
                    ));
                }
            }
        }
        Ok(())
    }

    /// Runs a `before` hook of a write on every plugin in order, stopping at the first that refuses the write.
    pub(crate) fn before_write(
        &self,
        hook_kind: WriteHook,
        hook: impl FnMut(&dyn Plugin) -> Result<()>,
    ) -> Result<()> {
        self.refuse(ErrorCode::DOC_VALIDATION_FAILED, hook_kind.label(), hook)
    }

    /// Runs [`Plugin::before_search`] on every plugin in order, stopping at the first that refuses the query.
    pub(crate) fn before_search(&self, index_name: &str, params: &mut QueryParams) -> Result<()> {
        self.refuse(ErrorCode::HOOK_ERROR, "beforeSearch", |plugin| {
            plugin.before_search(index_name, params)
        })
    }

    /// Runs a hook that reports finished work on every plugin in order, ignoring a panic inside any of them.
    pub(crate) fn after(&self, mut hook: impl FnMut(&dyn Plugin)) {
        let _scope = CallbackScope::enter(self);
        for plugin in self.current() {
            let _ = catch_unwind(AssertUnwindSafe(|| hook(plugin.as_ref())));
        }
    }

    /// Runs [`Plugin::on_partition_split`] on every plugin.
    pub(crate) fn partition_split(&self, index_name: &str, old_count: usize, new_count: usize) {
        self.after(|plugin| plugin.on_partition_split(index_name, old_count, new_count));
    }

    /// Runs [`Plugin::on_index_create`] on every plugin.
    pub(crate) fn index_created(&self, index_name: &str, config: &IndexConfig) {
        self.after(|plugin| plugin.on_index_create(index_name, config));
    }

    /// Runs [`Plugin::on_index_drop`] on every plugin.
    pub(crate) fn index_dropped(&self, index_name: &str, config: &IndexConfig) {
        self.after(|plugin| plugin.on_index_drop(index_name, config));
    }
}

impl Narsil {
    /// Adds `plugin` after every plugin that the engine already holds, so that its hooks run on every later write,
    /// query, and index change.
    pub fn add_plugin(&self, plugin: Arc<dyn Plugin>) {
        self.inner
            .plugins
            .plugins
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(plugin);
    }
}

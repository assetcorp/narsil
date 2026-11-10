use super::{BatchResult, Narsil};
use crate::error::Result;
use crate::value::Map;

/// The settings of one write, kept so that a write reads the same in this crate as in TypeScript.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WriteOptions {
    /// In TypeScript, a write with `wait` set returns only once every worker copy of the index has applied it.
    ///
    /// This crate holds one copy of each index, which every thread searches, and a write returns only once that
    /// copy has applied it, so every write already meets that promise, and the setting changes nothing.
    pub wait: Option<bool>,
}

impl Narsil {
    /// Returns once every search that starts afterwards sees every write to `index` that returned before the call.
    ///
    /// Every write returns only once the one copy of the index that every thread searches has applied it, so this
    /// returns at once. It fails with `INDEX_NOT_FOUND` where the engine holds no index called `index`, and with
    /// `INSTANCE_SHUT_DOWN` after [`Narsil::shutdown`].
    pub fn wait_for_writes(&self, index: &str) -> Result<()> {
        self.inner.open_index(index).map(|_| ())
    }

    /// Inserts a document as [`Narsil::insert`] does; `options` changes nothing, as [`WriteOptions::wait`] says.
    pub fn insert_with(
        &self,
        index: &str,
        document: Map,
        doc_id: Option<&str>,
        options: WriteOptions,
    ) -> Result<String> {
        let _ = options;
        self.insert(index, document, doc_id)
    }

    /// Inserts documents as [`Narsil::insert_batch`] does; `options` changes nothing, as [`WriteOptions::wait`]
    /// says.
    pub fn insert_batch_with(
        &self,
        index: &str,
        documents: Vec<Map>,
        options: WriteOptions,
    ) -> Result<BatchResult> {
        let _ = options;
        self.insert_batch(index, documents)
    }

    /// Replaces a document as [`Narsil::update`] does; `options` changes nothing, as [`WriteOptions::wait`] says.
    pub fn update_with(
        &self,
        index: &str,
        doc_id: &str,
        document: Map,
        options: WriteOptions,
    ) -> Result<()> {
        let _ = options;
        self.update(index, doc_id, document)
    }

    /// Replaces documents as [`Narsil::update_batch`] does; `options` changes nothing, as [`WriteOptions::wait`]
    /// says.
    pub fn update_batch_with(
        &self,
        index: &str,
        updates: Vec<(String, Map)>,
        options: WriteOptions,
    ) -> Result<BatchResult> {
        let _ = options;
        self.update_batch(index, updates)
    }

    /// Removes a document as [`Narsil::remove`] does; `options` changes nothing, as [`WriteOptions::wait`] says.
    pub fn remove_with(&self, index: &str, doc_id: &str, options: WriteOptions) -> Result<()> {
        let _ = options;
        self.remove(index, doc_id)
    }

    /// Removes documents as [`Narsil::remove_batch`] does; `options` changes nothing, as [`WriteOptions::wait`]
    /// says.
    pub fn remove_batch_with(
        &self,
        index: &str,
        doc_ids: Vec<String>,
        options: WriteOptions,
    ) -> Result<BatchResult> {
        let _ = options;
        self.remove_batch(index, doc_ids)
    }
}

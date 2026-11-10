mod import;
mod write;

use std::io::{Read, Write};

use super::Narsil;
use super::durable::archive::{archive_checkpoint, current_metadata, index_configuration};
use crate::error::Result;
pub use import::{DocumentImportResult, ImportRefusal};

impl Narsil {
    /// Writes every document of `index` to `out` as a document export: a JSON header line that carries the index's
    /// configuration, then one JSON line for each document with its vectors, which [`Narsil::import_documents`]
    /// reads in this release or any later one.
    ///
    /// The export holds every write that the engine acknowledged before the call, and later writes do not change
    /// it. A tagged value carries each value that JSON holds no type for, such as bytes, a date, or a number that
    /// is not finite.
    ///
    /// Fails with `INDEX_NOT_FOUND` for an unknown index, with `CONFIG_INVALID` where the index uses a tokenizer
    /// or a stop word function given as code, which an export cannot carry, and with `PERSISTENCE_SAVE_FAILED`
    /// where `out` refuses a write or a drop or a restore replaces the index while the export reads it.
    pub fn export_documents(&self, index: &str, out: &mut dyn Write) -> Result<()> {
        let state = self.inner.open_index(index)?;
        let configuration = index_configuration(&state, &current_metadata(&state))?;
        let checkpoint = archive_checkpoint(&state)?;
        write::write_document_export(&configuration, &checkpoint, out)
    }

    /// Reads a document export into `index`, creating the index from the export's header where the engine holds
    /// no index of that name, and returns how many documents it wrote and which lines it refused.
    ///
    /// The import inserts each document that the index lacks and replaces each document that it holds, in
    /// batches of 1,000. A line that holds no document, or a document that the index refuses, counts as refused,
    /// and the import goes on with the next line.
    ///
    /// Fails with `INSTANCE_SHUT_DOWN` after a shutdown, with `CONFIG_INVALID` for a missing or malformed header
    /// or where the existing index gives a field another type than the export does, and with
    /// `PERSISTENCE_LOAD_FAILED` where `data` fails a read.
    pub fn import_documents(
        &self,
        index: &str,
        data: &mut dyn Read,
    ) -> Result<DocumentImportResult> {
        self.inner.guard_shutdown()?;
        let imported = import::import_document_export(self, index, data);
        self.inner.events.wrote(index);
        imported
    }
}

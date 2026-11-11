mod earlier;
mod install;
mod prepare;
mod sink;
mod validate;

use std::io::{self, Read};

use super::index_lifecycle::enforce_limits;
use super::query_suggestions::restore_hooks::after_install;
use super::query_suggestions::restored_history::RestoredHistory;
use super::{EngineInner, Narsil};
use crate::config::validate_index_name;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::archive::read_snapshot_archive;
use earlier::{read_earlier_file, restore_earlier};
use install::{Staging, install};
use sink::StagingSink;
use validate::validate_staged_checkpoint;

const NRSL_MAGIC: &[u8; 4] = b"NRSL";

fn read_head(data: &mut dyn Read) -> Result<Vec<u8>> {
    let mut head = Vec::with_capacity(NRSL_MAGIC.len());
    Read::take(&mut *data, NRSL_MAGIC.len() as u64)
        .read_to_end(&mut head)
        .map_err(|error| {
            NarsilError::new(
                ErrorCode::PERSISTENCE_LOAD_FAILED,
                format!("The snapshot could not be read: {error}"),
            )
        })?;
    Ok(head)
}

fn restore_archive(
    engine: &EngineInner,
    name: &str,
    data: &mut dyn Read,
    staging: &mut Staging<'_>,
) -> Result<Option<RestoredHistory>> {
    let (prepared, manifest, history) = {
        let mut sink = StagingSink::new(engine, name, staging.store());
        read_snapshot_archive(data, &mut sink)?;
        sink.finish()?
    };
    validate_staged_checkpoint(&staging.source(), &manifest)?;
    install(engine, prepared, &manifest, staging)?;
    Ok(history)
}

fn restore_index(engine: &EngineInner, name: &str, data: &mut dyn Read) -> Result<()> {
    let head = read_head(data)?;
    if head.is_empty() {
        return Err(NarsilError::new(
            ErrorCode::DOC_VALIDATION_FAILED,
            "Snapshot data is empty",
        ));
    }
    let mut staging = Staging::begin(engine, name)?;
    let outcome = if head.as_slice() == NRSL_MAGIC {
        read_earlier_file(head, data)
            .and_then(|bytes| restore_earlier(engine, name, &bytes, &mut staging))
            .map(|()| None)
    } else {
        let mut whole = io::Cursor::new(head).chain(data);
        restore_archive(engine, name, &mut whole, &mut staging)
    };
    staging.discard();
    after_install(engine, name, outcome?);
    Ok(())
}

impl Narsil {
    /// Replaces the index `index` with the one that a snapshot holds, or creates it where the engine holds no
    /// index of that name.
    ///
    /// `data` gives the bytes of a snapshot archive that [`Narsil::snapshot`] wrote, in this release or another
    /// Narsil engine, or of the snapshot file that engine 0.3.0 returned, whose documents the restore inserts as
    /// new writes. The engine reads and checks every file of the snapshot before the index changes, and the old
    /// index keeps serving searches and writes until the restored one takes its place in one step. A durable
    /// engine moves the restored files into the index's place in that same step, so a crash leaves either the old
    /// index or the restored one.
    ///
    /// Fails with `INSTANCE_SHUT_DOWN` after a shutdown, with `CONFIG_INVALID` for a bad index name or a bad
    /// setting in the snapshot's configuration, with `DOC_VALIDATION_FAILED` for empty data or a malformed
    /// release 0.3 snapshot, with `ENVELOPE_VERSION_MISMATCH` for a file of an unknown version, and with
    /// `PERSISTENCE_LOAD_FAILED` for a malformed or damaged archive. The index keeps its earlier contents on any
    /// failure.
    pub fn restore(&self, index: &str, data: &mut dyn Read) -> Result<()> {
        let engine = &*self.inner;
        engine.guard_shutdown()?;
        validate_index_name(index)?;
        let restored = {
            let _name = engine.names.take(index);
            restore_index(engine, index, data)
        }
        .or_else(|error| engine.guard_shutdown().and(Err(error)));
        if restored.is_ok() {
            enforce_limits(engine, Some(index));
        }
        engine.events.wrote(index);
        restored
    }
}

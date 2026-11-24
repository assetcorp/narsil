use std::ptr;
use std::sync::{RwLock, RwLockReadGuard};

use crate::analysis::with_core_analyser;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::ffi;
use crate::native::status::core_refused;
use crate::native::workspace::with_workspace;

const MAX_FOLD_TABLE_ATTEMPTS: usize = 4;

struct RawFoldTable(*mut ffi::narsil_fold_table);

unsafe impl Send for RawFoldTable {}
unsafe impl Sync for RawFoldTable {}

impl Drop for RawFoldTable {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { ffi::narsil_fold_table_destroy(self.0) };
        }
    }
}

/// The fold table of one segment, which the native core builds from the segment's spellings and which a folded
/// search reads. A copy of a segment starts with an empty table, because the core matches a table to the memory of
/// the segment that built it.
pub(crate) struct FoldTableCell {
    table: RwLock<RawFoldTable>,
}

impl Default for FoldTableCell {
    fn default() -> FoldTableCell {
        FoldTableCell {
            table: RwLock::new(RawFoldTable(ptr::null_mut())),
        }
    }
}

impl Clone for FoldTableCell {
    fn clone(&self) -> FoldTableCell {
        FoldTableCell::default()
    }
}

fn poisoned() -> NarsilError {
    NarsilError::new(
        ErrorCode::INTERNAL_ERROR,
        "A thread panicked while it held the fold table of a segment",
    )
}

fn current(table: &RawFoldTable, segment: &ffi::narsil_expansion_segment, language: u32) -> bool {
    !table.0.is_null() && unsafe { ffi::narsil_fold_table_current(table.0, segment, language) } != 0
}

impl FoldTableCell {
    fn update(&self, segment: &ffi::narsil_expansion_segment, language: u32) -> Result<()> {
        let mut table = self.table.write().map_err(|_| poisoned())?;
        if current(&table, segment, language) {
            return Ok(());
        }
        if table.0.is_null() {
            let mut created = ptr::null_mut();
            let status = unsafe { ffi::narsil_fold_table_create(&mut created) };
            if status != ffi::NARSIL_OK {
                return Err(core_refused("a new fold table", status));
            }
            table.0 = created;
        }
        let raw = table.0;
        let status = with_workspace(|workspace| {
            with_core_analyser(|analyser| {
                Ok(unsafe {
                    ffi::narsil_fold_table_update(workspace, analyser, raw, segment, language)
                })
            })
        })?;
        match status {
            ffi::NARSIL_OK => Ok(()),
            status => Err(core_refused("a fold table update", status)),
        }
    }
}

/// The fold tables of every segment of a partition, held for reading while a folded search calls the core.
pub(crate) struct HeldFoldTables<'a> {
    _guards: Vec<RwLockReadGuard<'a, RawFoldTable>>,
    pointers: Vec<*const ffi::narsil_fold_table>,
}

impl HeldFoldTables<'_> {
    pub(crate) fn pointers(&self) -> *const *const ffi::narsil_fold_table {
        self.pointers.as_ptr()
    }
}

/// Brings the table of each segment up to date with the segment as `segments` presents it, then holds every table
/// for reading. A table that another search changes between the two steps sends the whole step round again.
pub(crate) fn hold_fold_tables<'a>(
    cells: &[&'a FoldTableCell],
    segments: &[ffi::narsil_expansion_segment],
    language: u32,
) -> Result<HeldFoldTables<'a>> {
    for _ in 0..MAX_FOLD_TABLE_ATTEMPTS {
        for (cell, segment) in cells.iter().zip(segments) {
            cell.update(segment, language)?;
        }
        let mut guards = Vec::with_capacity(cells.len());
        for cell in cells {
            guards.push(cell.table.read().map_err(|_| poisoned())?);
        }
        if guards
            .iter()
            .zip(segments)
            .all(|(guard, segment)| current(guard, segment, language))
        {
            let pointers = guards.iter().map(|guard| guard.0.cast_const()).collect();
            return Ok(HeldFoldTables {
                _guards: guards,
                pointers,
            });
        }
    }
    Err(NarsilError::new(
        ErrorCode::INTERNAL_ERROR,
        "The fold tables of a partition kept changing while a search read them",
    ))
}

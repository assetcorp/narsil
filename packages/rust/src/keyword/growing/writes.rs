use super::GrowingSegment;
use super::room::{grow_every_region, reserve_for};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::ffi;
use crate::keyword::constants::{
    MAX_ROOM_ATTEMPTS, POOL_VACUUM_FREE_DENOMINATOR, POOL_VACUUM_FREE_NUMERATOR,
    POOL_VACUUM_MIN_FREE_ENTRIES, POSITION_VACUUM_MIN_FREE_VALUES, TERM_TABLE_START_CAPACITY,
    TERM_VACUUM_MIN_DEAD_TERMS,
};
use crate::keyword::strings::SurfaceTable;
use crate::keyword::tokens::{SegmentFieldTokens, raw_fields};
use crate::native::status::core_refused;
use crate::native::workspace::with_workspace;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Indexed {
    Stored,
    SegmentFull,
}

type TermsWrite = unsafe extern "C" fn(
    *mut ffi::narsil_workspace,
    *const ffi::narsil_index_terms_request,
) -> ffi::narsil_status;

fn holds_surface(fields: &[SegmentFieldTokens<'_>]) -> bool {
    fields.iter().any(|field| {
        field.tokens.records.iter().any(|record| {
            record.surface_offset != ffi::NARSIL_NO_SURFACE && record.surface_length > 0
        })
    })
}

fn out_of_room(operation: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::PARTITION_CORRUPTED,
        format!("The keyword segment found no room for {operation} after growing every region"),
    )
}

fn sparse_pool(free: usize, end: usize, least: usize) -> bool {
    free >= least && free * POOL_VACUUM_FREE_DENOMINATOR > end * POOL_VACUUM_FREE_NUMERATOR
}

fn sparse_strings(table: Option<&SurfaceTable>) -> bool {
    table.is_some_and(|table| {
        let live = table.live_len();
        let dead = table.len() - live;
        dead >= TERM_VACUUM_MIN_DEAD_TERMS && dead > live
    })
}

impl GrowingSegment {
    fn vacuum_if_sparse(&mut self) -> Result<()> {
        let live = self.terms.live_count();
        let dead = self.terms.count() - live;
        let sparse = (dead >= TERM_VACUUM_MIN_DEAD_TERMS && dead > live)
            || sparse_pool(
                self.postings.free_entries(),
                self.postings.end(),
                POOL_VACUUM_MIN_FREE_ENTRIES,
            )
            || self.positions.as_ref().is_some_and(|positions| {
                sparse_pool(
                    positions.free_values(),
                    positions.end(),
                    POSITION_VACUUM_MIN_FREE_VALUES,
                )
            })
            || sparse_strings(self.surfaces.as_ref())
            || sparse_strings(self.spellings.as_ref().map(|table| table.entries()));
        if sparse {
            self.end_batch()?;
        }
        Ok(())
    }

    fn require_ordinal(&mut self, ordinal: u32, fields: &[SegmentFieldTokens<'_>]) -> Result<()> {
        let field_count = fields
            .iter()
            .map(|field| field.field as usize + 1)
            .max()
            .unwrap_or(0);
        self.reserve_fields(ordinal as usize + 1, field_count)
    }

    fn write_terms(
        &mut self,
        ordinal: u32,
        fields: &[ffi::narsil_field_tokens],
        write: TermsWrite,
    ) -> Result<ffi::narsil_status> {
        let request = ffi::narsil_index_terms_request {
            segment: self.raw(),
            ordinal,
            fields: fields.as_ptr(),
            field_count: fields.len(),
        };
        with_workspace(|workspace| Ok(unsafe { write(workspace, &request) }))
    }

    pub(crate) fn index(
        &mut self,
        ordinal: u32,
        fields: &[SegmentFieldTokens<'_>],
    ) -> Result<Indexed> {
        self.require_ordinal(ordinal, fields)?;
        self.vacuum_if_sparse()?;
        if self.surfaces.is_none() && holds_surface(fields) {
            self.surfaces = Some(SurfaceTable::new());
        }
        let raw = raw_fields(fields);
        let mut reserved = false;
        for _ in 0..MAX_ROOM_ATTEMPTS {
            match self.write_terms(ordinal, &raw, ffi::narsil_index_terms)? {
                ffi::NARSIL_OK => return Ok(Indexed::Stored),
                ffi::NARSIL_SEGMENT_FULL => return Ok(Indexed::SegmentFull),
                ffi::NARSIL_NEEDS_ROOM if !reserved => {
                    reserve_for(self, fields)?;
                    reserved = true;
                }
                ffi::NARSIL_NEEDS_ROOM => grow_every_region(self)?,
                status => return Err(core_refused("a document's terms", status)),
            }
        }
        Err(out_of_room("a document's terms"))
    }

    pub(crate) fn remove(&mut self, ordinal: u32, fields: &[SegmentFieldTokens<'_>]) -> Result<()> {
        self.require_ordinal(ordinal, fields)?;
        self.vacuum_if_sparse()?;
        let raw = raw_fields(fields);
        for _ in 0..MAX_ROOM_ATTEMPTS {
            match self.write_terms(ordinal, &raw, ffi::narsil_remove_document)? {
                ffi::NARSIL_OK => return Ok(()),
                ffi::NARSIL_NEEDS_ROOM => grow_every_region(self)?,
                status => return Err(core_refused("a document's removal", status)),
            }
        }
        Err(out_of_room("a document's removal"))
    }

    fn holds_no_keywords(&self) -> bool {
        self.terms.count() == 0
            && self.postings.end() == 0
            && self.postings.free_entries() == 0
            && self
                .positions
                .as_ref()
                .is_none_or(|positions| positions.end() <= 1 && positions.free_values() == 0)
            && self.surfaces.as_ref().is_none_or(|table| table.len() == 0)
            && self
                .spellings
                .as_ref()
                .is_none_or(|table| table.entries().len() == 0)
    }

    fn batch(&mut self, ending: bool) -> Result<()> {
        if self.holds_no_keywords() {
            return Ok(());
        }
        let generation = self.terms.generation();
        let segment = self.raw();
        let status = with_workspace(|workspace| {
            Ok(unsafe {
                if ending {
                    ffi::narsil_end_batch(workspace, segment)
                } else {
                    ffi::narsil_begin_batch(workspace, segment)
                }
            })
        })?;
        if status != ffi::NARSIL_OK {
            return Err(core_refused("a batch boundary", status));
        }
        if self.terms.generation() != generation {
            self.trim();
        }
        Ok(())
    }

    fn trim(&mut self) {
        self.terms.trim(TERM_TABLE_START_CAPACITY);
        self.columns.trim(self.terms.capacity());
        self.postings.trim();
        if let Some(positions) = &mut self.positions {
            positions.trim();
        }
        if let Some(surfaces) = &mut self.surfaces {
            surfaces.trim();
        }
        if let Some(spellings) = &mut self.spellings {
            spellings.trim();
        }
    }

    pub(crate) fn begin_batch(&mut self) -> Result<()> {
        self.batch(false)
    }

    pub(crate) fn end_batch(&mut self) -> Result<()> {
        self.batch(true)
    }
}

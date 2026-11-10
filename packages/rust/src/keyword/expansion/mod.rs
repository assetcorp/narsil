mod partial;
mod prefix;
mod suggestions;

use std::ptr;

use super::growing::GrowingRead;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::ffi;
use crate::index::partition::PartitionSnapshot;
use crate::index::segment::{SegmentData, SegmentEntry};
use crate::search::lookup::token_text;

pub(crate) use partial::PartialWordRequest;

enum HeldView {
    Growing(Box<GrowingRead>),
    Frozen(ffi::narsil_frozen_segment_state),
}

pub(crate) struct ExpansionSources<'a> {
    entries: &'a [SegmentEntry],
    segments: Vec<ffi::narsil_expansion_segment>,
    runs: Vec<ffi::narsil_frozen_runs>,
    _views: Box<[HeldView]>,
}

fn pointer<T>(values: &[T]) -> *const T {
    if values.is_empty() {
        ptr::null()
    } else {
        values.as_ptr()
    }
}

fn no_runs() -> ffi::narsil_frozen_runs {
    ffi::narsil_frozen_runs {
        points: ptr::null(),
        point_count: 0,
        offsets: ptr::null(),
        offset_count: 0,
        members: ptr::null(),
        member_count: 0,
    }
}

fn corrupted(message: &str) -> NarsilError {
    NarsilError::new(ErrorCode::PARTITION_CORRUPTED, message)
}

pub(crate) fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn utf8_entry(text: &[u8], offsets: &[u32], at: usize) -> Option<String> {
    let start = *offsets.get(at)? as usize;
    let end = *offsets.get(at + 1)? as usize;
    let bytes = text.get(start..end)?;
    std::str::from_utf8(bytes).ok().map(str::to_string)
}

fn held_view(entry: &SegmentEntry) -> Result<HeldView> {
    match &entry.data {
        SegmentData::Tail(tail) => Ok(HeldView::Growing(tail.keyword.read())),
        SegmentData::Frozen(_) => entry
            .state
            .as_ref()
            .map(|state| HeldView::Frozen(state.raw_view()))
            .ok_or_else(|| {
                corrupted("A frozen segment holds no removal state for the native core to read")
            }),
    }
}

impl<'a> ExpansionSources<'a> {
    pub(crate) fn of(snapshot: &'a PartitionSnapshot) -> Result<ExpansionSources<'a>> {
        let entries = snapshot.segments.as_slice();
        let mut views = Vec::with_capacity(entries.len());
        for entry in entries {
            views.push(held_view(entry)?);
        }
        let views = views.into_boxed_slice();
        let mut segments = Vec::with_capacity(entries.len());
        let mut runs = Vec::with_capacity(entries.len());
        for (entry, view) in entries.iter().zip(views.iter()) {
            match (&entry.data, view) {
                (SegmentData::Frozen(segment), HeldView::Frozen(state)) => {
                    let occurrences = segment.occurrences()?;
                    segments.push(ffi::narsil_expansion_segment {
                        growing: ptr::null(),
                        frozen: segment.view.raw(),
                        state,
                        occurrences: pointer(occurrences),
                        occurrence_count: occurrences.len(),
                    });
                    runs.push(segment.payload.partial_words.as_ref().map_or_else(
                        no_runs,
                        |words| ffi::narsil_frozen_runs {
                            points: pointer(&words.runs),
                            point_count: words.runs.len(),
                            offsets: pointer(&words.run_offsets),
                            offset_count: words.run_offsets.len(),
                            members: pointer(&words.run_entries),
                            member_count: words.run_entries.len(),
                        },
                    ));
                }
                (SegmentData::Tail(_), HeldView::Growing(read)) => {
                    segments.push(ffi::narsil_expansion_segment {
                        growing: read.segment(),
                        frozen: ptr::null(),
                        state: ptr::null(),
                        occurrences: ptr::null(),
                        occurrence_count: 0,
                    });
                    runs.push(no_runs());
                }
                _ => return Err(corrupted("A segment changed kind while a search read it")),
            }
        }
        Ok(ExpansionSources {
            entries,
            segments,
            runs,
            _views: views,
        })
    }

    fn entry(&self, segment: u32) -> Result<&'a SegmentEntry> {
        self.entries
            .get(segment as usize)
            .ok_or_else(|| corrupted("The native core named a segment outside the partition"))
    }

    pub(crate) fn token(&self, segment: u32, token: u32) -> Result<String> {
        Ok(token_text(self.entry(segment)?, token).into_owned())
    }

    pub(crate) fn surface(&self, segment: u32, surface: u32) -> Result<String> {
        let at = surface as usize;
        let text = match &self.entry(segment)?.data {
            SegmentData::Tail(tail) => tail
                .keyword
                .surfaces
                .as_ref()
                .map(|table| String::from_utf16_lossy(table.text(at))),
            SegmentData::Frozen(frozen) => frozen
                .payload
                .surface_forms
                .as_ref()
                .and_then(|forms| utf8_entry(&forms.text, &forms.offsets, at * 2)),
        };
        text.ok_or_else(|| corrupted("The native core named a surface form that the segment lacks"))
    }

    fn segments(&self) -> (*const ffi::narsil_expansion_segment, usize) {
        (pointer(&self.segments), self.segments.len())
    }

    fn runs(&self) -> *const ffi::narsil_frozen_runs {
        pointer(&self.runs)
    }
}

use std::cell::RefCell;
use std::ptr;

use super::request::RequestBuilder;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::ffi;

/// The posting arrays that a request's pool lists point into.
#[derive(Clone, Copy)]
pub(crate) struct Pool<'a> {
    pub(crate) documents: &'a [u32],
    pub(crate) frequencies: &'a [u16],
    pub(crate) fields: &'a [u16],
}

/// The per-field numbers of one segment's field table, in the layout that the native core reads.
pub(crate) struct FieldScoring<'a> {
    pub(crate) searchable: Vec<u8>,
    pub(crate) partial_marks: Vec<u8>,
    pub(crate) name_ranks: &'a [u16],
    pub(crate) numbers: Vec<f64>,
    pub(crate) lengths: Vec<&'a [u32]>,
}

/// The settings of one request that the planner leaves to the caller.
pub(crate) struct Settings<'a> {
    pub(crate) terms: usize,
    pub(crate) capacity: u32,
    pub(crate) total_documents: f64,
    pub(crate) limit: Option<usize>,
    pub(crate) collect: bool,
    pub(crate) filter: Option<&'a [u32]>,
    pub(crate) removed: &'a [u32],
}

/// The documents that one request scored, with ordinals local to the segment.
pub(crate) struct Scored {
    pub(crate) ordinals: Vec<u32>,
    pub(crate) scores: Vec<f64>,
    pub(crate) total_matched: u32,
    pub(crate) matched: Option<Vec<u32>>,
}

struct Workspace {
    handle: *mut ffi::narsil_workspace,
    ordinals: Vec<i32>,
    scores: Vec<f64>,
    matched: Vec<u32>,
    live: Vec<u32>,
}

impl Drop for Workspace {
    fn drop(&mut self) {
        unsafe { ffi::narsil_workspace_destroy(self.handle) };
    }
}

thread_local! {
    static WORKSPACE: RefCell<Option<Workspace>> = const { RefCell::new(None) };
}

fn core_failed(what: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::INTERNAL_ERROR,
        format!("The native core could not score the query, because {what}"),
    )
}

fn created_workspace() -> Result<Workspace> {
    let mut handle = ptr::null_mut();
    let status = unsafe { ffi::narsil_workspace_create(&mut handle) };
    if status != ffi::NARSIL_OK || handle.is_null() {
        return Err(core_failed("it ran out of memory"));
    }
    Ok(Workspace {
        handle,
        ordinals: Vec::new(),
        scores: Vec::new(),
        matched: Vec::new(),
        live: Vec::new(),
    })
}

fn words_for(capacity: u32) -> usize {
    (capacity as usize).div_ceil(32)
}

fn length_u32(length: usize, what: &str) -> Result<u32> {
    u32::try_from(length).map_err(|_| core_failed(&format!("the request holds too many {what}")))
}

fn columns_of(scoring: &FieldScoring<'_>) -> Vec<ffi::narsil_keyword_column> {
    scoring
        .lengths
        .iter()
        .map(|column| ffi::narsil_keyword_column {
            values: if column.is_empty() {
                ptr::null()
            } else {
                column.as_ptr()
            },
            length: column.len().min(u32::MAX as usize) as u32,
        })
        .collect()
}

fn pointer<T>(values: &[T]) -> *const T {
    if values.is_empty() {
        ptr::null()
    } else {
        values.as_ptr()
    }
}

fn scored_by_the_core(
    workspace: &mut Workspace,
    builder: &RequestBuilder,
    pool: Pool<'_>,
    fields: &FieldScoring<'_>,
    settings: &Settings<'_>,
) -> Result<Scored> {
    let capacity = settings.capacity;
    if capacity > i32::MAX as u32 {
        return Err(core_failed("the segment holds too many documents"));
    }
    let words = words_for(capacity);
    let slots = length_u32(builder.slot_count(), "slots")?;
    let lists = length_u32(builder.list_count(), "lists")?;
    let field_count = length_u32(fields.searchable.len(), "fields")?;
    let pool_length = length_u32(
        pool.documents
            .len()
            .min(pool.frequencies.len())
            .min(pool.fields.len()),
        "postings",
    )?;
    let row_length = length_u32(builder.row_documents.len(), "rows")?;
    if workspace.ordinals.len() < capacity as usize {
        workspace.ordinals.resize(capacity as usize, 0);
        workspace.scores.resize(capacity as usize, 0.0);
    }
    if workspace.matched.len() < words {
        workspace.matched.resize(words, 0);
    }
    if workspace.live.len() < words {
        workspace.live.resize(words, u32::MAX);
    }
    let columns = columns_of(fields);
    let filter = settings.filter.unwrap_or(&[]);
    let request = ffi::narsil_keyword_request {
        pool_doc_ids: pointer(pool.documents),
        pool_frequencies: pointer(pool.frequencies),
        pool_fields: pointer(pool.fields),
        pool_length,
        row_doc_ids: pointer(&builder.row_documents),
        row_frequencies: pointer(&builder.row_frequencies),
        row_fields: pointer(&builder.row_fields),
        row_length,
        slots: pointer(&builder.slots),
        slot_count: slots,
        slot_capacity: slots,
        lists: pointer(&builder.lists),
        list_values: pointer(&builder.list_values),
        list_capacity: lists,
        slot_values: pointer(&builder.slot_values),
        slot_value_capacity: length_u32(builder.slot_values.len(), "slot values")?,
        field_count,
        searchable: pointer(&fields.searchable),
        partial_marks: pointer(&fields.partial_marks),
        name_ranks: pointer(fields.name_ranks),
        field_numbers: pointer(&fields.numbers),
        lengths: pointer(&columns),
        has_filter: i32::from(settings.filter.is_some()),
        filter: pointer(filter),
        filter_words: length_u32(filter.len(), "filter words")?,
        live: pointer(&workspace.live),
        live_words: length_u32(words, "documents")?,
        removed: pointer(settings.removed),
        removed_words: length_u32(settings.removed.len(), "removed documents")?,
        terms: settings.terms as f64,
        capacity,
        total_documents: settings.total_documents,
        term_match: 0.0,
        limit: settings
            .limit
            .map_or(ffi::NARSIL_KEYWORD_NO_LIMIT, |limit| limit as f64),
        min_score: 0.0,
        collect: i32::from(settings.collect),
    };
    let mut output = ffi::narsil_keyword_output {
        ordinals: workspace.ordinals.as_mut_ptr(),
        scores: workspace.scores.as_mut_ptr(),
        length: length_u32(workspace.ordinals.len(), "documents")?,
        matched: workspace.matched.as_mut_ptr(),
        matched_words: length_u32(workspace.matched.len(), "documents")?,
        count: 0,
        total_matched: 0,
        scoring_path: 0,
    };
    let status = unsafe { ffi::narsil_keyword_score(workspace.handle, &request, &mut output) };
    match status {
        ffi::NARSIL_OK => {}
        ffi::NARSIL_OUT_OF_MEMORY => return Err(core_failed("it ran out of memory")),
        _ => return Err(core_failed("it refused the request")),
    }
    let count = (output.count as usize).min(workspace.ordinals.len());
    let mut ordinals = Vec::with_capacity(count);
    let mut scores = Vec::with_capacity(count);
    for at in 0..count {
        let Ok(ordinal) = u32::try_from(workspace.ordinals[at]) else {
            continue;
        };
        if ordinal < capacity {
            ordinals.push(ordinal);
            scores.push(workspace.scores[at]);
        }
    }
    Ok(Scored {
        ordinals,
        scores,
        total_matched: output.total_matched,
        matched: settings
            .collect
            .then(|| workspace.matched[..words].to_vec()),
    })
}

/// Scores one segment's request on the native core, on a workspace that belongs to the calling thread.
pub(crate) fn score(
    builder: &RequestBuilder,
    pool: Pool<'_>,
    fields: &FieldScoring<'_>,
    settings: &Settings<'_>,
) -> Result<Scored> {
    WORKSPACE.with(|cell| {
        let mut held = cell
            .try_borrow_mut()
            .map_err(|_| core_failed("a callback scored a query inside another query"))?;
        let workspace = match held.as_mut() {
            Some(workspace) => workspace,
            None => held.insert(created_workspace()?),
        };
        scored_by_the_core(workspace, builder, pool, fields, settings)
    })
}

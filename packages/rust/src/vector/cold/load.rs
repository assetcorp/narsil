use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::error::{Result, load_failed};
use crate::format::envelope::HEADER_BYTES;
use crate::format::graph_part::GraphParts;
use crate::format::vector_file::{DiskColumns, VectorCodes, VectorFile};
use crate::util::bytes::f64_list;
use crate::value::{Value, decode_value};

use super::super::build::schedule_build;
use super::super::constants::{
    COLD_LOAD_WAIT_WITHOUT_SEARCH_MS, COLD_REPLAY_ROUNDS_BESIDE_SEARCHES,
    COLD_WRITES_REPLAYED_WHILE_SEARCHES_WAIT,
};
use super::super::field::Shared;
use super::super::restore::{
    CheckpointRestoreShape, LoadedVectorFile, VectorFileLocation, begin_restore_of,
};
use super::field::ColdFile;
use super::writes::replay;
use super::{ColdHold, Progress};

pub(crate) type GraphPartsReader =
    Box<dyn FnOnce(&dyn Fn() -> bool) -> Result<Option<GraphParts>> + Send>;

pub(super) fn start(
    shared: Arc<Shared>,
    hold: Arc<ColdHold>,
    read_graph: GraphPartsReader,
) -> Option<JoinHandle<()>> {
    std::thread::Builder::new()
        .name("narsil-vector-load".to_string())
        .spawn(move || run(&shared, &hold, read_graph))
        .ok()
}

fn still_wanted(shared: &Shared, hold: &ColdHold) -> bool {
    !shared.disposed.load(Ordering::Acquire) && !matches!(hold.lock().progress, Progress::Cancelled)
}

fn wait_before_load(shared: &Shared, hold: &ColdHold) -> bool {
    let deadline = Instant::now() + Duration::from_millis(COLD_LOAD_WAIT_WITHOUT_SEARCH_MS);
    let mut state = hold.lock();
    loop {
        if shared.disposed.load(Ordering::Acquire) || matches!(state.progress, Progress::Cancelled)
        {
            return false;
        }
        let now = Instant::now();
        if state.load_wanted || now >= deadline {
            break;
        }
        state = match hold.changed.wait_timeout(state, deadline - now) {
            Ok((state, _)) => state,
            Err(poisoned) => poisoned.into_inner().0,
        };
    }
    state.progress = Progress::Loading;
    true
}

fn doc_ids_of(file: &ColdFile) -> Result<Vec<String>> {
    let listed = file.file.whole_checked(&file.sections.doc_ids)?;
    let ids = match decode_value(&listed) {
        Ok(Value::Array(items)) if items.len() == file.count as usize => items
            .into_iter()
            .map(|item| match item {
                Value::String(id) => Some(id),
                _ => None,
            })
            .collect::<Option<Vec<String>>>(),
        _ => None,
    };
    match ids {
        Some(ids) => Ok(ids),
        None => load_failed(format!(
            "The vector file \"{}\" lists the wrong number of IDs",
            file.key
        )),
    }
}

fn loaded_by_sections(
    shared: &Shared,
    hold: &ColdHold,
    file: &ColdFile,
) -> Result<Option<LoadedVectorFile>> {
    let field = &hold.field;
    let wanted = || still_wanted(shared, hold);
    let sections = &file.sections;
    let doc_ids = doc_ids_of(file)?;
    if !wanted() {
        return Ok(None);
    }
    let records = sections
        .records
        .as_ref()
        .map(|records| file.file.whole_checked(records))
        .transpose()?;
    if !wanted() {
        return Ok(None);
    }
    let magnitudes = f64_list(
        &file.file.whole_checked(&sections.magnitudes)?,
        "magnitudes",
    )?;
    file.file.check_every_page(&sections.vectors, &wanted)?;
    if !wanted() {
        return Ok(None);
    }
    let codes = match (records, field.codes()) {
        (Some(records), Some(codes)) => Some(VectorCodes {
            bits: codes.bits,
            centroid: codes
                .centroid
                .iter()
                .map(|&value| f64::from(value))
                .collect(),
            records,
        }),
        _ => None,
    };
    Ok(Some(LoadedVectorFile {
        id: file.id,
        key: file.key.clone(),
        file: VectorFile {
            field_name: shared.settings.field_name.clone(),
            dimension: field.dimension(),
            doc_ids,
            codes,
            vectors: Vec::new(),
            disk: Some(DiskColumns {
                magnitudes,
                id_order: Vec::new(),
            }),
        },
        dead: file.dead.clone(),
        location: Some(VectorFileLocation {
            path: file.file.path().to_path_buf(),
            vectors_offset: HEADER_BYTES as u64 + sections.vectors.offset,
        }),
    }))
}

fn load(shared: &Arc<Shared>, hold: &ColdHold, read_graph: GraphPartsReader) -> Result<bool> {
    let graph = read_graph(&|| still_wanted(shared, hold))?;
    if !still_wanted(shared, hold) {
        return Ok(false);
    }
    let field = &hold.field;
    let mut restore = begin_restore_of(
        shared,
        CheckpointRestoreShape {
            live_vectors: field.live_count(),
            holds_graph: true,
            graph,
        },
    );
    for file in field.files() {
        if !still_wanted(shared, hold) {
            return Ok(false);
        }
        let Some(loaded) = loaded_by_sections(shared, hold, file)? else {
            return Ok(false);
        };
        restore.add_file(loaded)?;
    }
    if !still_wanted(shared, hold) {
        return Ok(false);
    }
    restore.finish()?;
    Ok(true)
}

fn end_hold(shared: &Arc<Shared>, hold: &Arc<ColdHold>) -> Result<()> {
    let mut writer = shared.lock_writer();
    for _ in 0..COLD_REPLAY_ROUNDS_BESIDE_SEARCHES {
        let waiting = {
            let mut state = hold.lock();
            if matches!(state.progress, Progress::Cancelled) {
                return Ok(());
            }
            if state.writes.len() <= COLD_WRITES_REPLAYED_WHILE_SEARCHES_WAIT {
                break;
            }
            std::mem::take(&mut state.writes)
        };
        replay(shared, &mut writer, waiting)?;
    }
    let mut state = hold.lock();
    if matches!(state.progress, Progress::Cancelled) {
        return Ok(());
    }
    let waiting = std::mem::take(&mut state.writes);
    replay(shared, &mut writer, waiting)?;
    state.progress = Progress::Ended;
    shared.release_cold_hold(hold);
    Ok(())
}

fn run(shared: &Arc<Shared>, hold: &Arc<ColdHold>, read_graph: GraphPartsReader) {
    let outcome = if wait_before_load(shared, hold) {
        match load(shared, hold, read_graph) {
            Ok(true) => end_hold(shared, hold),
            Ok(false) => Ok(()),
            Err(error) => Err(error),
        }
    } else {
        Ok(())
    };
    {
        let mut state = hold.lock();
        if let Err(error) = outcome
            && matches!(state.progress, Progress::Waiting | Progress::Loading)
        {
            state.progress = Progress::Failed(error);
        }
    }
    hold.changed.notify_all();
    schedule_build(shared);
}

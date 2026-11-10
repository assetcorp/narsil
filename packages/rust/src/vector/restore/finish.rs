use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use crate::error::Result;
use crate::format::graph_part::GraphParts;

use super::super::build::{connect_unlinked, level_of, schedule_build};
use super::super::calibration::measure_live;
use super::super::checkpoint::{SavedVectorFile, signature_of};
use super::super::constants::{DRIFT_CHECK_GROWTH_FACTOR, RECALIBRATION_CHUNK_VECTORS};
use super::super::core::{core_failed, with_scratch};
use super::super::field::{BufferList, Shared, Writer};
use super::super::graph::{GraphTables, upper_words_of};
use super::super::maintenance::release_replaced;
use super::super::numbered::{
    NO_ORDINAL, NumberedParts, require_upper_lists_within_bound, require_whole_lists,
    restore_numbered,
};
use super::super::store::FLAG_BUFFERED;
use super::VectorRestore;
use crate::ffi;

const CALIBRATION_NEVER_CURRENT: i32 = -1;

fn quantise_all(shared: &Shared, writer: &Writer, ordinals: &[u32]) -> Result<()> {
    let metric = shared.settings.metric_code();
    let store = &writer.generation.store;
    let listed: Vec<i32> = ordinals.iter().map(|&ordinal| ordinal as i32).collect();
    with_scratch(|scratch| {
        for chunk in listed.chunks(RECALIBRATION_CHUNK_VECTORS) {
            scratch.quantise(store, metric, chunk)?;
        }
        Ok(())
    })
}

fn recalibrate_from_store(shared: &Shared, writer: &mut Writer, tombstoned: &[u32]) -> Result<()> {
    let generation = Arc::clone(&writer.generation);
    let live = generation.live_ordinals();
    generation.store.clear_every_code();
    if let Some(mean) = measure_live(shared, &generation)? {
        generation.store.set_centroid(&mean.centroid);
        quantise_all(shared, writer, &live)?;
        quantise_all(shared, writer, tombstoned)?;
    }
    let count = live.len() as u64;
    writer.calibrated_count = Some(count);
    writer.calibrated_mean_length = None;
    shared.history.next_drift_check_at.store(
        count.max(1).saturating_mul(DRIFT_CHECK_GROWTH_FACTOR),
        Ordering::Release,
    );
    Ok(())
}

fn buffer_outside(shared: &Shared, writer: &mut Writer, graph: Option<&GraphTables>) {
    let generation = Arc::clone(&writer.generation);
    let store = &generation.store;
    let mut lacking = Vec::new();
    for ordinal in generation.live_ordinals() {
        let flags = store.flags(ordinal);
        if graph.is_some_and(|found| found.holds_live_node(ordinal)) {
            store.set_flags(ordinal, flags & !FLAG_BUFFERED);
        } else {
            store.set_flags(ordinal, flags | FLAG_BUFFERED);
            lacking.push(ordinal);
        }
    }
    let buffer = BufferList::with_capacity((lacking.len() + 1) * 2);
    for &ordinal in &lacking {
        buffer.push(ordinal);
    }
    generation
        .counts
        .buffered
        .store(lacking.len() as u64, Ordering::Release);
    shared.publish(
        writer,
        generation.with(|parts| parts.buffer = Arc::new(buffer)),
    );
}

fn place_later_nodes(
    shared: &Shared,
    writer: &Writer,
    graph: GraphTables,
    later: &NumberedParts<'_>,
    ordinal_of_number: &[i32],
) -> Result<GraphTables> {
    for part in later.parts {
        require_whole_lists(part)?;
    }
    let store = &writer.generation.store;
    let wanted: Vec<u32> = ordinal_of_number
        .iter()
        .enumerate()
        .filter(|&(number, _)| later.top_layer(number) >= 0)
        .filter_map(|(_, &ordinal)| u32::try_from(ordinal).ok())
        .filter(|&ordinal| store.is_live(ordinal) && !graph.holds_node(ordinal))
        .collect();
    if wanted.is_empty() {
        return Ok(graph);
    }
    let slots = wanted
        .iter()
        .map(|&ordinal| ordinal as usize + 1)
        .max()
        .unwrap_or(0);
    let upper: usize = wanted
        .iter()
        .map(|&ordinal| upper_words_of(graph.m, level_of(ordinal, graph.m)))
        .sum::<usize>()
        + graph.upper_used();
    let graph = if slots > graph.slot_capacity() || upper > graph.upper_capacity() {
        graph.copied(slots, upper)
    } else {
        graph
    };
    quantise_all(shared, writer, &wanted)?;
    let metric = graph.metric;
    with_scratch(|scratch| {
        for &ordinal in &wanted {
            let status = scratch.place(
                store,
                &graph,
                metric,
                ordinal,
                level_of(ordinal, graph.m),
                false,
            );
            if status != ffi::NARSIL_OK {
                return Err(core_failed(status, "place a vector in its graph"));
            }
        }
        Ok(())
    })?;
    connect_unlinked(writer, &graph)?;
    Ok(graph)
}

fn adopt_restored_graph(shared: &Shared, writer: &mut Writer, graph: Option<Arc<GraphTables>>) {
    let next = writer.generation.with(|parts| parts.graph = graph);
    shared.publish(writer, next);
    shared
        .history
        .compacted_node_count
        .store(0, Ordering::Release);
}

fn restore_graph(
    shared: &Shared,
    writer: &mut Writer,
    payload: Option<&GraphParts>,
    ordinal_of_number: &[i32],
    tombstoned: &[u32],
    codes_restored: bool,
) -> Result<()> {
    if let Some(found) = payload {
        for parts in &found.graphs {
            require_upper_lists_within_bound(parts)?;
        }
    }
    let first_graph =
        payload.and_then(|found| Some((found.graphs.first()?, *found.part_size.first()?)));
    let Some((parts, part_size)) = first_graph.filter(|(parts, _)| !parts.is_empty()) else {
        release_replaced(writer);
        buffer_outside(shared, writer, None);
        return Ok(());
    };
    let numbered = NumberedParts { parts, part_size };
    let slots = writer.generation.store.slots() as usize;
    let Some(graph) = restore_numbered(&numbered, ordinal_of_number, slots)? else {
        release_replaced(writer);
        buffer_outside(shared, writer, None);
        return Ok(());
    };
    for &ordinal in tombstoned {
        graph.mark_tombstone_directly(ordinal);
    }
    let header = &parts[0];
    let shuffled = header.shuffled_build_count.map(u64::from);
    shared.history.set_shuffled_build_count(shuffled);
    if codes_restored
        && let Some(count) = shuffled
        && writer.generation.store.calibrated()
    {
        writer.calibrated_count = Some(count);
        writer.calibrated_mean_length = header.calibrated_mean_length;
        shared.history.next_drift_check_at.store(
            count.max(1).saturating_mul(DRIFT_CHECK_GROWTH_FACTOR),
            Ordering::Release,
        );
    }
    let mut graph = graph;
    if let Some(found) = payload {
        for (later, &size) in found.graphs.iter().zip(&found.part_size).skip(1) {
            let numbered_later = NumberedParts {
                parts: later,
                part_size: size,
            };
            graph = place_later_nodes(shared, writer, graph, &numbered_later, ordinal_of_number)?;
        }
    }
    let graph = Arc::new(graph);
    adopt_restored_graph(shared, writer, Some(Arc::clone(&graph)));
    buffer_outside(shared, writer, Some(&graph));
    if writer.generation.buffer.len() as u64 <= graph.size() {
        return Ok(());
    }
    adopt_restored_graph(shared, writer, None);
    shared.history.set_shuffled_build_count(None);
    release_replaced(writer);
    buffer_outside(shared, writer, None);
    Ok(())
}

impl VectorRestore {
    pub(crate) fn finish(mut self) -> Result<()> {
        let shared = Arc::clone(&self.shared);
        let mut writer = shared.lock_writer();
        let codes_restored = self.restores_codes && self.codes_agree && self.centroid.is_some();
        if codes_restored && let Some(centroid) = &self.centroid {
            let centroid: Vec<f32> = centroid.iter().map(|&value| value as f32).collect();
            writer.generation.store.set_centroid(&centroid);
        }
        if self.restores_codes && !codes_restored {
            recalibrate_from_store(&shared, &mut writer, &self.tombstoned)?;
        }
        let store = Arc::clone(&writer.generation.store);
        let tombstoned: HashSet<u32> = self.tombstoned.iter().copied().collect();
        let mut ordinal_of_number = Vec::with_capacity(self.next_number);
        for file in &mut self.files {
            for ordinal in &mut file.ordinals {
                let held = u32::try_from(*ordinal).is_ok_and(|found| {
                    store.present(found) && (store.is_live(found) || tombstoned.contains(&found))
                });
                if !held {
                    *ordinal = NO_ORDINAL;
                }
            }
            ordinal_of_number.extend_from_slice(&file.ordinals);
        }
        let payload = self.graph.take();
        restore_graph(
            &shared,
            &mut writer,
            payload.as_ref(),
            &ordinal_of_number,
            &self.tombstoned,
            codes_restored,
        )?;
        let signature = signature_of(&shared, &writer);
        let coded_under = match (codes_restored, signature.calibration) {
            (true, Some(current)) => current,
            _ => CALIBRATION_NEVER_CURRENT,
        };
        writer.saved_files = self
            .files
            .drain(..)
            .map(|file| SavedVectorFile {
                id: file.id,
                key: file.key,
                ordinals: file.ordinals,
                calibration: file.coded.then_some(coded_under),
            })
            .collect();
        writer.saved_signature = Some(signature);
        writer.holds_publication = false;
        shared.publish_held(&writer);
        drop(writer);
        self.finished = true;
        shared.restoring.store(false, Ordering::Release);
        schedule_build(&shared);
        Ok(())
    }
}

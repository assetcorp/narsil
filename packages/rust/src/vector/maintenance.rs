use std::sync::Arc;
use std::sync::atomic::Ordering;

use crate::error::Result;
use crate::ffi;

use super::build::{
    building, carry_out, fresh_plan, grow_plan, lock_gate, schedule_build, shuffled_rebuild_due,
    wait_for_builds,
};
use super::calibration::{calibrate_before_build, recalibrate_when_drifted};
use super::constants::{
    ESTIMATED_MS_PER_TOMBSTONE, ESTIMATED_MS_PER_VECTOR_REBUILD, MIN_ORDINAL_CAPACITY,
    REBUILD_REMOVED_RATIO,
};
use super::core::with_scratch;
use super::field::{BufferList, Counts, Generation, Shared, VectorField, Writer};
use super::graph::GraphTables;
use super::store::{FLAG_CURRENT, FLAG_REMOVED, FLAG_REPLACED};
use super::writes::graphs_of;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct MaintenanceStatus {
    pub(crate) tombstone_ratio: f64,
    pub(crate) graph_count: u32,
    pub(crate) buffer_size: u64,
    pub(crate) building: bool,
    pub(crate) waiting_for_memory: bool,
    pub(crate) loading_from_files: bool,
    pub(crate) estimated_compact_ms: u64,
    pub(crate) estimated_optimize_ms: u64,
}

pub(crate) fn graph_needs_rebuild(shared: &Shared, generation: &Generation) -> bool {
    let Some(graph) = &generation.graph else {
        return false;
    };
    let removed =
        graph.tombstone_count() + shared.history.compacted_node_count.load(Ordering::Acquire);
    let held = graph.size() + removed;
    held > 0 && removed as f64 / held as f64 > REBUILD_REMOVED_RATIO
}

fn compact_graph(shared: &Shared, writer: &Writer, graph: &GraphTables) -> Result<()> {
    let _published = writer.generation.store.hold_published()?;
    let _alone = graph.hold_alone();
    if graph.incoming_uncounted() {
        graph.count_incoming();
    }
    let mut nearby = Vec::new();
    let mut list = Vec::new();
    for ordinal in 0..graph.slots() {
        if !graph.holds_tombstone(ordinal) {
            continue;
        }
        graph.list(ordinal, 0, &mut list);
        nearby.extend(
            list.iter()
                .filter(|&&neighbour| !graph.holds_tombstone(neighbour))
                .map(|&neighbour| neighbour as i32),
        );
    }
    let metric = shared.settings.metric_code();
    let store = &writer.generation.store;
    with_scratch(|scratch| {
        scratch.compact(store, graph, metric)?;
        scratch.connect(store, graph, metric, &nearby)
    })?;
    graph.set_word(ffi::NARSIL_GRAPH_WORD_UNLINKED_NODES, 0);
    Ok(())
}

pub(crate) fn compact_held(shared: &Shared, writer: &mut Writer) -> Result<()> {
    let generation = Arc::clone(&writer.generation);
    let counts = &generation.counts;
    if counts.removed.load(Ordering::Acquire) == 0 && counts.replaced.load(Ordering::Acquire) == 0 {
        return Ok(());
    }
    if let Some(graph) = &generation.graph {
        shared
            .history
            .compacted_node_count
            .fetch_add(graph.tombstone_count(), Ordering::AcqRel);
    }
    for graph in graphs_of(writer) {
        compact_graph(shared, writer, &graph)?;
    }
    let store = &generation.store;
    let oldest_pin = store.oldest_pin();
    for ordinal in std::mem::take(&mut writer.removed_ordinals) {
        let flags = store.flags(ordinal);
        if flags & (FLAG_CURRENT | FLAG_REMOVED) != FLAG_CURRENT | FLAG_REMOVED {
            continue;
        }
        if writer.is_placing(ordinal) || !store.may_free(ordinal, oldest_pin) {
            writer.removed_ordinals.push(ordinal);
            continue;
        }
        if let Some(doc_id) = generation.doc_id(ordinal) {
            generation.ids.delete(doc_id, &generation.names);
        }
        store.set_flags(ordinal, 0);
        store.set_present(ordinal, false);
        store.clear_code(ordinal);
        Counts::add(&counts.removed, -1);
        Counts::add(&counts.held, -1);
    }
    release_replaced(writer);
    store.set_held_documents(counts.held.load(Ordering::Acquire));
    Ok(())
}

pub(crate) fn release_replaced(writer: &mut Writer) {
    let generation = Arc::clone(&writer.generation);
    let store = &generation.store;
    let oldest_pin = store.oldest_pin();
    for ordinal in std::mem::take(&mut writer.replaced_ordinals) {
        if store.flags(ordinal) & FLAG_REPLACED == 0 {
            continue;
        }
        if writer.is_placing(ordinal) || !store.may_free(ordinal, oldest_pin) {
            writer.replaced_ordinals.push(ordinal);
            continue;
        }
        store.set_flags(ordinal, 0);
        store.set_present(ordinal, false);
        store.clear_code(ordinal);
        Counts::add(&generation.counts.replaced, -1);
    }
}

fn drop_graph(shared: &Shared, writer: &mut Writer) {
    let generation = Arc::clone(&writer.generation);
    writer.job = None;
    generation.counts.buffered.store(0, Ordering::Release);
    generation.store.clear_every_code();
    generation.store.forget_calibration();
    shared.history.set_shuffled_build_count(None);
    shared
        .history
        .compacted_node_count
        .store(0, Ordering::Release);
    let next = generation.with(|parts| {
        parts.graph = None;
        parts.buffer = Arc::new(BufferList::with_capacity(MIN_ORDINAL_CAPACITY));
    });
    shared.publish(writer, next);
}

fn plan_optimisation(shared: &Shared, writer: &mut Writer) -> Result<Option<super::build::Plan>> {
    let rebuild_needed = graph_needs_rebuild(shared, &writer.generation);
    compact_held(shared, writer)?;
    let live = writer.generation.counts.live();
    if live == 0 {
        drop_graph(shared, writer);
        return Ok(None);
    }
    let graph = writer.generation.graph.clone();
    let Some(graph) =
        graph.filter(|_| !rebuild_needed && shared.history.shuffled_build_count().is_some())
    else {
        if !calibrate_before_build(shared, writer)? {
            return Ok(None);
        }
        return Ok(Some(fresh_plan(shared, writer)));
    };
    if recalibrate_when_drifted(shared, writer, live)? {
        return Ok(Some(fresh_plan(shared, writer)));
    }
    let generation = &writer.generation;
    let missing: Vec<u32> = generation
        .live_ordinals()
        .into_iter()
        .filter(|&ordinal| !graph.holds_live_node(ordinal) || generation.is_buffered(ordinal))
        .collect();
    Ok(Some(grow_plan(writer, graph, missing)))
}

impl VectorField {
    pub(crate) fn compact(&self) -> Result<()> {
        if self.shared.is_cold() {
            return Ok(());
        }
        let mut writer = self.shared.lock_writer();
        compact_held(&self.shared, &mut writer)
    }

    pub(crate) fn optimize(&self) -> Result<()> {
        self.until_loaded()?;
        {
            let _gate = lock_gate(&self.shared);
            let plan = {
                let mut writer = self.shared.lock_writer();
                plan_optimisation(&self.shared, &mut writer)?
            };
            if let Some(plan) = plan {
                carry_out(&self.shared, plan)?;
            }
        }
        schedule_build(&self.shared);
        Ok(())
    }

    pub(crate) fn wait_for_builds(&self) -> Result<()> {
        self.until_loaded()?;
        wait_for_builds(&self.shared);
        Ok(())
    }

    pub(crate) fn maintenance_status(&self) -> MaintenanceStatus {
        let shared = &self.shared;
        let generation = shared.current();
        let counts = &generation.counts;
        let held = counts.held.load(Ordering::Acquire);
        let buffered = counts.buffered.load(Ordering::Acquire);
        let graph_nodes = generation
            .graph
            .as_ref()
            .map_or(held, |graph| graph.size() + graph.tombstone_count());
        let tombstoned =
            counts.removed.load(Ordering::Acquire) + counts.replaced.load(Ordering::Acquire);
        let scale = shared.settings.dimension_scale();
        let rebuilds = match &generation.graph {
            None => true,
            Some(graph) => {
                graph_needs_rebuild(shared, &generation)
                    || shuffled_rebuild_due(shared, graph, counts.live())
            }
        };
        let optimised = if rebuilds { held } else { buffered };
        let cold = shared.is_cold();
        MaintenanceStatus {
            tombstone_ratio: if graph_nodes > 0 {
                tombstoned as f64 / graph_nodes as f64
            } else {
                0.0
            },
            graph_count: u32::from(cold || generation.graph.is_some()),
            buffer_size: buffered,
            building: building(shared),
            waiting_for_memory: false,
            loading_from_files: cold || shared.restoring.load(Ordering::Acquire),
            estimated_compact_ms: (tombstoned as f64 * ESTIMATED_MS_PER_TOMBSTONE * scale).round()
                as u64,
            estimated_optimize_ms: (optimised as f64 * ESTIMATED_MS_PER_VECTOR_REBUILD * scale)
                .round() as u64,
        }
    }

    pub(crate) fn memory_bytes(&self) -> usize {
        let generation = self.shared.current();
        let graph_bytes = generation
            .graph
            .as_ref()
            .map_or(0, |graph| graph.memory_bytes());
        let building_bytes = {
            let writer = self.shared.lock_writer();
            writer
                .job
                .as_ref()
                .and_then(|job| job.graph.as_ref())
                .map_or(0, |graph| graph.memory_bytes())
        };
        let scratch_bytes = with_scratch(|scratch| Ok(scratch.workspace_bytes())).unwrap_or(0);
        let cold_bytes = self
            .shared
            .cold_hold()
            .map_or(0, |hold| hold.memory_bytes());
        cold_bytes
            + generation.store.memory_bytes()
            + generation.ids.memory_bytes()
            + graph_bytes
            + building_bytes
            + scratch_bytes
    }
}

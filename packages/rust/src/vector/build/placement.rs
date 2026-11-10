use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use crate::error::Result;
use crate::ffi;

use super::super::constants::BUILD_CHUNK_VECTORS;
use super::super::core::{core_failed, with_scratch};
use super::super::field::{BufferList, Counts, Placing, Shared, Writer};
use super::super::graph::{GraphTables, HeldAlone, upper_words_of};
use super::super::store::{FLAG_BUFFERED, StoreTables};
use super::super::writes::compacted_buffer;
use super::{BuildJob, Plan, level_of, still_current};

const PLACEMENT_ROOM_REQUESTS: usize = 3;

fn admitted_batch(writer: &Writer, plan: &Plan, ordinals: &[u32]) -> Vec<u32> {
    let generation = &writer.generation;
    ordinals
        .iter()
        .copied()
        .filter(|&ordinal| generation.store.is_live(ordinal) && !plan.graph.holds_node(ordinal))
        .collect()
}

fn ensure_graph_room(shared: &Shared, writer: &mut Writer, plan: &mut Plan, ordinals: &[u32]) {
    let graph = &plan.graph;
    let m = graph.m;
    let slots = ordinals
        .iter()
        .map(|&ordinal| ordinal as usize + 1)
        .max()
        .unwrap_or(0);
    let upper: usize = ordinals
        .iter()
        .map(|&ordinal| upper_words_of(m, level_of(ordinal, m)))
        .sum();
    let upper_wanted = graph.upper_used() + upper;
    if slots <= graph.slot_capacity() && upper_wanted <= graph.upper_capacity() {
        return;
    }
    let grown = Arc::new(graph.copied(
        slots.max(graph.slot_capacity() * 2),
        upper_wanted.max(graph.upper_capacity() * 2),
    ));
    replace_graph(shared, writer, plan, grown);
}

fn replace_graph(shared: &Shared, writer: &mut Writer, plan: &mut Plan, grown: Arc<GraphTables>) {
    plan.graph = Arc::clone(&grown);
    if plan.fresh {
        writer.job = Some(BuildJob {
            graph: Some(grown),
            fresh: true,
        });
        return;
    }
    let next = writer.generation.with(|parts| parts.graph = Some(grown));
    shared.publish(writer, next);
}

fn count_incoming_when_uncounted(writer: &Writer, graph: &GraphTables) -> Result<()> {
    if !graph.incoming_uncounted() {
        return Ok(());
    }
    let _alone = graph.hold_alone();
    if graph.count_incoming() {
        let store = &writer.generation.store;
        with_scratch(|scratch| scratch.connect(store, graph, graph.metric, &[]))?;
    }
    graph.set_word(ffi::NARSIL_GRAPH_WORD_UNLINKED_NODES, 0);
    Ok(())
}

fn connect_unlinked(writer: &Writer, graph: &GraphTables) -> Result<()> {
    if graph.word(ffi::NARSIL_GRAPH_WORD_UNLINKED_NODES) == 0 {
        return Ok(());
    }
    connect_unreached(writer, graph)
}

pub(crate) fn connect_unreached(writer: &Writer, graph: &GraphTables) -> Result<()> {
    let alone = graph.hold_alone();
    connect_held_alone(writer, graph, &alone)
}

pub(crate) fn connect_held_alone(
    writer: &Writer,
    graph: &GraphTables,
    _alone: &HeldAlone<'_>,
) -> Result<()> {
    let store = &writer.generation.store;
    with_scratch(|scratch| scratch.connect(store, graph, graph.metric, &[]))?;
    graph.set_word(ffi::NARSIL_GRAPH_WORD_UNLINKED_NODES, 0);
    Ok(())
}

struct Placement<'a> {
    store: &'a StoreTables,
    graph: &'a GraphTables,
    ordinals: &'a [u32],
    cursor: AtomicUsize,
    short_of_room: Mutex<Vec<u32>>,
}

fn place_share(placement: &Placement<'_>) -> Result<()> {
    let graph = placement.graph;
    with_scratch(|scratch| {
        let mut codes: Vec<i32> = Vec::with_capacity(BUILD_CHUNK_VECTORS);
        loop {
            let start = placement
                .cursor
                .fetch_add(BUILD_CHUNK_VECTORS, Ordering::AcqRel);
            if start >= placement.ordinals.len() {
                return Ok(());
            }
            let end = (start + BUILD_CHUNK_VECTORS).min(placement.ordinals.len());
            let chunk = &placement.ordinals[start..end];
            codes.clear();
            codes.extend(
                chunk
                    .iter()
                    .filter(|&&ordinal| !placement.store.has_code(ordinal))
                    .map(|&ordinal| ordinal as i32),
            );
            scratch.quantise(placement.store, graph.metric, &codes)?;
            for &ordinal in chunk {
                let top_layer = level_of(ordinal, graph.m);
                let status = scratch.place(
                    placement.store,
                    graph,
                    graph.metric,
                    ordinal,
                    top_layer,
                    false,
                );
                match status {
                    ffi::NARSIL_OK => {}
                    ffi::NARSIL_NEEDS_ROOM => placement
                        .short_of_room
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .push(ordinal),
                    _ => return Err(core_failed(status, "place a vector in its graph")),
                }
            }
        }
    })
}

fn place_in_parallel(
    store: &StoreTables,
    graph: &GraphTables,
    ordinals: &[u32],
    threads: usize,
) -> Result<Vec<u32>> {
    let placement = Placement {
        store,
        graph,
        ordinals,
        cursor: AtomicUsize::new(0),
        short_of_room: Mutex::new(Vec::new()),
    };
    let workers = threads
        .min(ordinals.len().div_ceil(BUILD_CHUNK_VECTORS))
        .max(1);
    let outcome = if workers == 1 {
        place_share(&placement)
    } else {
        std::thread::scope(|scope| {
            let handles: Vec<_> = (0..workers)
                .map(|_| scope.spawn(|| place_share(&placement)))
                .collect();
            let mut outcome = Ok(());
            for handle in handles {
                let joined = handle.join().unwrap_or_else(|_| {
                    Err(core_failed(
                        ffi::NARSIL_INVALID_ARGUMENT,
                        "finish placing vectors",
                    ))
                });
                if outcome.is_ok() {
                    outcome = joined;
                }
            }
            outcome
        })
    };
    outcome?;
    Ok(placement
        .short_of_room
        .into_inner()
        .unwrap_or_else(|poisoned| poisoned.into_inner()))
}

fn quantise_missing(store: &StoreTables, graph: &GraphTables, ordinals: &[u32]) -> Result<()> {
    let codes: Vec<i32> = ordinals
        .iter()
        .filter(|&&ordinal| !store.has_code(ordinal))
        .map(|&ordinal| ordinal as i32)
        .collect();
    if codes.is_empty() {
        return Ok(());
    }
    with_scratch(|scratch| scratch.quantise(store, graph.metric, &codes))
}

fn tombstone_retired(writer: &Writer, graph: &GraphTables, ordinals: &[u32]) -> Result<()> {
    let store = &writer.generation.store;
    for &ordinal in ordinals {
        if !store.is_live(ordinal) && graph.holds_live_node(ordinal) {
            with_scratch(|scratch| scratch.remove(graph, ordinal))?;
        }
    }
    Ok(())
}

/// Places `ordinals` in the plan's graph with the writer lock free, so that inserts and removals go on while the
/// core walks the graph, and returns false where the field dropped or replaced that graph meanwhile.
///
/// A store that a write copies in that time lacks the codes that the placement wrote into the old one, so a graph
/// that searches already read takes every code under the lock first, and a fresh graph takes the codes again from
/// the current store before anything reads it. A vector that a write removes or replaces meanwhile keeps its
/// vector and code until the placement ends, and then leaves the graph as a tombstone.
pub(crate) fn place_batch(
    shared: &Shared,
    plan: &mut Plan,
    ordinals: &[u32],
    threads: usize,
) -> Result<bool> {
    let mut writer = shared.lock_writer();
    if !still_current(&writer, plan) {
        return Ok(false);
    }
    let mut admitted = admitted_batch(&writer, plan, ordinals);
    if admitted.is_empty() {
        return Ok(true);
    }
    for _ in 0..PLACEMENT_ROOM_REQUESTS {
        ensure_graph_room(shared, &mut writer, plan, &admitted);
        count_incoming_when_uncounted(&writer, &plan.graph)?;
        let store = Arc::clone(&writer.generation.store);
        if !plan.fresh {
            quantise_missing(&store, &plan.graph, &admitted)?;
        }
        writer.placing = Some(Placing::of(&plan.graph, &admitted));
        drop(writer);
        let placed = place_in_parallel(&store, &plan.graph, &admitted, threads);
        writer = shared.lock_writer();
        writer.placing = None;
        let short_of_room = placed?;
        if !still_current(&writer, plan) {
            return Ok(false);
        }
        let current = Arc::clone(&writer.generation.store);
        if !Arc::ptr_eq(&current, &store) {
            quantise_missing(&current, &plan.graph, &admitted)?;
        }
        tombstone_retired(&writer, &plan.graph, &admitted)?;
        connect_unlinked(&writer, &plan.graph)?;
        admitted = short_of_room
            .into_iter()
            .filter(|&ordinal| current.is_live(ordinal))
            .collect();
        if admitted.is_empty() {
            break;
        }
    }
    if !admitted.is_empty() {
        return Err(core_failed(
            ffi::NARSIL_NEEDS_ROOM,
            "place a vector in its graph",
        ));
    }
    if !plan.fresh {
        settle_placed(shared, &mut writer, &plan.graph, ordinals);
    }
    Ok(true)
}

fn settle_placed(shared: &Shared, writer: &mut Writer, graph: &GraphTables, ordinals: &[u32]) {
    let generation = Arc::clone(&writer.generation);
    for &ordinal in ordinals {
        let flags = generation.store.flags(ordinal);
        if flags & FLAG_BUFFERED != 0 && graph.holds_live_node(ordinal) {
            generation.store.set_flags(ordinal, flags & !FLAG_BUFFERED);
            Counts::add(&generation.counts.buffered, -1);
        }
    }
    let lacking = compacted_buffer(&generation);
    shared.publish(
        writer,
        generation.with(|parts| parts.buffer = Arc::new(lacking)),
    );
}

pub(crate) fn adopt(shared: &Shared, writer: &mut Writer, graph: &Arc<GraphTables>) {
    let generation = Arc::clone(&writer.generation);
    let store = &generation.store;
    let mut lacking = Vec::new();
    for ordinal in generation.live_ordinals() {
        if !graph.holds_live_node(ordinal) {
            lacking.push(ordinal);
        }
    }
    let oldest_pin = store.oldest_pin();
    let retired_unplaced: Vec<u32> = generation
        .buffer
        .ordinals()
        .filter(|&ordinal| {
            !store.is_live(ordinal)
                && !graph.holds_node(ordinal)
                && store.present(ordinal)
                && !store.may_free(ordinal, oldest_pin)
        })
        .collect();
    let buffer = BufferList::with_capacity((lacking.len() + retired_unplaced.len() + 1) * 2);
    for &ordinal in &lacking {
        store.set_flags(ordinal, store.flags(ordinal) | FLAG_BUFFERED);
        buffer.push(ordinal);
    }
    for &ordinal in &retired_unplaced {
        buffer.push(ordinal);
    }
    generation
        .counts
        .buffered
        .store(lacking.len() as u64, Ordering::Release);
    writer.job = None;
    let next = generation.with(|parts| {
        parts.graph = Some(Arc::clone(graph));
        parts.buffer = Arc::new(buffer);
    });
    shared.publish(writer, next);
    for ordinal in 0..store.slots() {
        let flags = store.flags(ordinal);
        if flags & FLAG_BUFFERED != 0 && graph.holds_live_node(ordinal) {
            store.set_flags(ordinal, flags & !FLAG_BUFFERED);
        }
    }
    shared.history.set_shuffled_build_count(Some(graph.size()));
    shared
        .history
        .compacted_node_count
        .store(0, Ordering::Release);
}

use std::sync::Arc;

use crate::error::{ErrorCode, NarsilError, Result};

use super::build::schedule_build;
use super::constants::{MAX_VECTOR_ORDINALS, MIN_ORDINAL_CAPACITY};
use super::core::with_scratch;
use super::doc_ids::Placed;
use super::field::{BufferList, Counts, Generation, Shared, VectorField, Writer};
use super::graph::GraphTables;
use super::store::{
    FLAG_BUFFERED, FLAG_CURRENT, FLAG_REMOVED, FLAG_REPLACED, StoreTables, magnitude_of,
};

pub(crate) enum Held<'a> {
    InMemory(&'a [f32]),
    InFile {
        magnitude: f64,
        file: usize,
        offset: u32,
    },
}

pub(crate) fn require_dimension_of(shared: &Shared, length: usize) -> Result<()> {
    let dimension = shared.settings.dimension;
    if length != dimension {
        return Err(NarsilError::new(
            ErrorCode::VECTOR_DIMENSION_MISMATCH,
            format!("Vector dimension mismatch: expected {dimension}, got {length}"),
        ));
    }
    Ok(())
}

impl VectorField {
    pub(crate) fn insert(&self, doc_id: &str, vector: &[f32]) -> Result<()> {
        require_dimension_of(&self.shared, vector.len())?;
        let sequence = self.shared.sequence.next();
        if let Some(hold) = self.shared.cold_hold()
            && hold.insert(doc_id, vector, sequence)?
        {
            return Ok(());
        }
        {
            let mut writer = self.shared.lock_writer();
            insert_stamped(&self.shared, &mut writer, doc_id, vector, sequence)?;
        }
        schedule_build(&self.shared);
        Ok(())
    }

    pub(crate) fn remove(&self, doc_id: &str) -> Result<()> {
        let sequence = self.shared.sequence.next();
        if let Some(hold) = self.shared.cold_hold()
            && hold.remove(doc_id, sequence)?
        {
            return Ok(());
        }
        {
            let mut writer = self.shared.lock_writer();
            remove_stamped(&mut writer, doc_id, sequence)?;
        }
        schedule_build(&self.shared);
        Ok(())
    }
}

fn holds_this_vector_already(store: &StoreTables, ordinal: u32, vector: &[f32]) -> bool {
    if store.flags(ordinal) & (FLAG_CURRENT | FLAG_REMOVED) != FLAG_CURRENT {
        return false;
    }
    let mut held = vec![0f32; vector.len()];
    store.read_vector(ordinal, &mut held) && held.iter().zip(vector).all(|(a, b)| a == b)
}

pub(crate) fn insert_stamped(
    shared: &Shared,
    writer: &mut Writer,
    doc_id: &str,
    vector: &[f32],
    sequence: i64,
) -> Result<()> {
    let previous = writer.generation.ordinal_of(doc_id);
    if let Some(ordinal) = previous
        && holds_this_vector_already(&writer.generation.store, ordinal, vector)
    {
        return Ok(());
    }
    writer.revision += 1;
    if let Some(ordinal) = previous {
        retire_previous(writer, ordinal, sequence)?;
    }
    append(
        shared,
        writer,
        doc_id,
        Held::InMemory(vector),
        Stamp {
            flags: FLAG_CURRENT | FLAG_BUFFERED,
            born: sequence,
        },
    )?;
    Ok(())
}

pub(crate) fn remove_stamped(writer: &mut Writer, doc_id: &str, sequence: i64) -> Result<()> {
    let generation = Arc::clone(&writer.generation);
    let Some(ordinal) = generation.ordinal_of(doc_id) else {
        return Ok(());
    };
    let flags = generation.store.flags(ordinal);
    if flags & FLAG_CURRENT == 0 {
        return Ok(());
    }
    writer.revision += 1;
    generation.store.stamp_retired(ordinal, sequence);
    let counts = &generation.counts;
    if flags & FLAG_REMOVED == 0 {
        Counts::add(&counts.removed, 1);
        writer.removed_ordinals.push(ordinal);
    }
    if flags & FLAG_BUFFERED != 0 {
        Counts::add(&counts.buffered, -1);
    }
    generation
        .store
        .set_flags(ordinal, (flags | FLAG_REMOVED) & !FLAG_BUFFERED);
    writer.pending_locations.remove(&ordinal);
    tombstone_everywhere(writer, ordinal)
}

pub(crate) fn graphs_of(writer: &Writer) -> Vec<Arc<GraphTables>> {
    let mut graphs: Vec<Arc<GraphTables>> = writer.generation.graph.iter().cloned().collect();
    if let Some(job) = &writer.job
        && let Some(graph) = &job.graph
    {
        graphs.push(Arc::clone(graph));
    }
    graphs
}

fn tombstone_everywhere(writer: &Writer, ordinal: u32) -> Result<()> {
    for graph in graphs_of(writer) {
        if graph.holds_node(ordinal) {
            with_scratch(|scratch| scratch.remove(&graph, ordinal))?;
        }
    }
    Ok(())
}

pub(crate) fn retire_previous(writer: &mut Writer, ordinal: u32, sequence: i64) -> Result<()> {
    let generation = Arc::clone(&writer.generation);
    let store = &generation.store;
    let counts = &generation.counts;
    let flags = store.flags(ordinal);
    if flags & FLAG_CURRENT == 0 {
        return Ok(());
    }
    store.stamp_retired(ordinal, sequence);
    if flags & FLAG_REMOVED != 0 {
        Counts::add(&counts.removed, -1);
    }
    if flags & FLAG_BUFFERED != 0 {
        Counts::add(&counts.buffered, -1);
    }
    Counts::add(&counts.held, -1);
    let graph_holds = writer.is_placing(ordinal)
        || graphs_of(writer)
            .iter()
            .any(|graph| graph.holds_node(ordinal));
    if graph_holds {
        store.set_flags(ordinal, FLAG_REPLACED);
        Counts::add(&counts.replaced, 1);
        writer.replaced_ordinals.push(ordinal);
        tombstone_everywhere(writer, ordinal)?;
    } else if !store.may_free(ordinal, store.oldest_pin()) {
        store.set_flags(ordinal, FLAG_REPLACED);
        Counts::add(&counts.replaced, 1);
        writer.replaced_ordinals.push(ordinal);
    } else {
        store.set_flags(ordinal, 0);
        store.set_present(ordinal, false);
        store.clear_code(ordinal);
    }
    store.set_held_documents(counts.held.load(std::sync::atomic::Ordering::Acquire));
    Ok(())
}

pub(crate) struct Stamp {
    pub(crate) flags: u8,
    pub(crate) born: i64,
}

pub(crate) fn append(
    shared: &Shared,
    writer: &mut Writer,
    doc_id: &str,
    held: Held<'_>,
    stamp: Stamp,
) -> Result<u32> {
    let flags = stamp.flags;
    let ordinal = writer.generation.store.slots();
    if ordinal >= MAX_VECTOR_ORDINALS {
        return Err(NarsilError::new(
            ErrorCode::PARTITION_CAPACITY_EXCEEDED,
            format!(
                "A vector field holds at most {MAX_VECTOR_ORDINALS} vectors, deleted ones included, until it is rebuilt"
            ),
        ));
    }
    ensure_room(shared, writer, ordinal as usize + 1);
    let generation = Arc::clone(&writer.generation);
    let store = &generation.store;
    match held {
        Held::InMemory(vector) => store.write_vector(ordinal, vector, magnitude_of(vector)),
        Held::InFile {
            magnitude,
            file,
            offset,
        } => store.write_location(ordinal, magnitude, file as i32, offset),
    }
    store.set_present(ordinal, true);
    store.set_flags(ordinal, flags);
    generation.names.set(ordinal, doc_id);
    if flags & FLAG_CURRENT != 0 && store.calibrated() {
        let metric = shared.settings.metric_code();
        with_scratch(|scratch| scratch.quantise(store, metric, &[ordinal as i32]))?;
    }
    store.stamp_born(ordinal, stamp.born);
    if flags & FLAG_CURRENT == 0 {
        store.stamp_retired(ordinal, stamp.born);
    } else if let Some(earlier) = generation.ordinal_of(doc_id) {
        store.set_earlier_ordinal(ordinal, earlier);
    }
    store.set_slots(ordinal + 1);
    let counts = &generation.counts;
    if flags & FLAG_CURRENT != 0 {
        if let Placed::Added = generation.ids.put(doc_id, ordinal, &generation.names) {
            writer.id_slots_used += 1;
        }
        Counts::add(&counts.held, 1);
        store.set_held_documents(counts.held.load(std::sync::atomic::Ordering::Acquire));
    }
    if flags & FLAG_REPLACED != 0 {
        Counts::add(&counts.replaced, 1);
        writer.replaced_ordinals.push(ordinal);
    }
    if flags & FLAG_BUFFERED != 0 {
        generation.buffer.push(ordinal);
        Counts::add(&counts.buffered, 1);
    }
    Ok(ordinal)
}

fn ensure_room(shared: &Shared, writer: &mut Writer, slots: usize) {
    let generation = Arc::clone(&writer.generation);
    let store_short = slots > generation.store.capacity();
    let buffer_short = generation.buffer.len() >= generation.buffer_capacity();
    let ids_short = !generation.ids.fits(writer.id_slots_used + 1);
    if !store_short && !buffer_short && !ids_short {
        return;
    }
    let mut ids_used = writer.id_slots_used;
    let next = generation.with(|parts| {
        if store_short {
            let capacity = (generation.store.capacity() * 2)
                .max(slots)
                .max(MIN_ORDINAL_CAPACITY)
                .min(MAX_VECTOR_ORDINALS as usize);
            let files = generation.store.files().owners().to_vec();
            parts.store = Arc::new(generation.store.copied(capacity, files, &|_| true));
        }
        if buffer_short {
            parts.buffer = Arc::new(compacted_buffer(&generation));
        }
        if ids_short {
            let entries = generation.ids.ordinals().count();
            parts.ids = Arc::new(generation.ids.rebuilt(entries * 2 + 1, &generation.names));
            ids_used = entries;
        }
    });
    writer.id_slots_used = ids_used;
    shared.publish(writer, next);
}

fn still_scanned(generation: &Generation, ordinal: u32, oldest_pin: i64) -> bool {
    if generation.is_buffered(ordinal) {
        return true;
    }
    let placed = generation
        .graph
        .as_ref()
        .is_some_and(|graph| graph.holds_node(ordinal));
    !placed && generation.store.present(ordinal) && !generation.store.may_free(ordinal, oldest_pin)
}

pub(crate) fn compacted_buffer(generation: &Generation) -> BufferList {
    let oldest_pin = generation.store.oldest_pin();
    let held: Vec<u32> = generation
        .buffer
        .ordinals()
        .filter(|&ordinal| still_scanned(generation, ordinal, oldest_pin))
        .collect();
    let list = BufferList::with_capacity((held.len() + 1) * 2);
    for ordinal in held {
        list.push(ordinal);
    }
    list
}

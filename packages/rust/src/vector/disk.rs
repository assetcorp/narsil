use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;

use crate::error::Result;

use super::build::wait_for_builds;
use super::field::{Generation, Shared, VectorField, Writer};
use super::files::MappedFile;

pub(crate) struct VectorFileLayout<'a> {
    pub(crate) path: &'a Path,
    pub(crate) vectors_offset: u64,
    pub(crate) ordinals: &'a [i32],
    pub(crate) dead: Option<&'a [u8]>,
}

pub(crate) fn is_dead(dead: Option<&[u8]>, position: usize) -> bool {
    dead.is_some_and(|bits| {
        bits.get(position >> 3)
            .is_some_and(|byte| (byte >> (position & 7)) & 1 == 1)
    })
}

fn holds_vectors_on_disk(shared: &Shared, writer: &Writer) -> bool {
    shared.settings.reads_from_disk() && writer.generation.graph.is_some()
}

fn file_index_of(owners: &mut Vec<Arc<MappedFile>>, path: &Path) -> Result<usize> {
    if let Some(found) = owners.iter().position(|file| file.path() == path) {
        return Ok(found);
    }
    owners.push(MappedFile::open(path)?);
    Ok(owners.len() - 1)
}

pub(crate) fn release_pending_locations(shared: &Shared, writer: &mut Writer) -> Result<()> {
    if writer.pending_locations.is_empty() || !holds_vectors_on_disk(shared, writer) {
        return Ok(());
    }
    let pending = std::mem::take(&mut writer.pending_locations);
    release_locations(shared, writer, pending)
}

fn release_locations(
    shared: &Shared,
    writer: &mut Writer,
    pending: HashMap<u32, (PathBuf, u64)>,
) -> Result<()> {
    let generation = Arc::clone(&writer.generation);
    let previous = &generation.store;
    let mut owners = previous.files().owners().to_vec();
    let mut moves = Vec::with_capacity(pending.len());
    for (ordinal, (path, offset)) in pending {
        if !previous.is_live(ordinal) || previous.file_of(ordinal).is_some() {
            continue;
        }
        let Ok(offset) = u32::try_from(offset) else {
            continue;
        };
        let file = file_index_of(&mut owners, &path)?;
        let readable = owners[file]
            .length()
            .checked_sub(u64::from(offset))
            .is_some_and(|room| room >= previous.dimension as u64 * 4);
        if readable {
            moves.push((ordinal, file, offset));
        }
    }
    if moves.is_empty() {
        return Ok(());
    }
    let located = previous.with_files(owners);
    for (ordinal, file, offset) in moves {
        located.write_location(ordinal, previous.magnitude(ordinal), file as i32, offset);
    }
    let released = Arc::new(located.without_file_blocks());
    shared.publish(writer, generation.with(|parts| parts.store = released));
    Ok(())
}

impl VectorField {
    pub(crate) fn adopt_disk_layout(&self, layout: &VectorFileLayout<'_>) -> Result<()> {
        if !self.shared.settings.reads_from_disk() || layout.ordinals.is_empty() {
            return Ok(());
        }
        let stride = self.dimension() as u64 * 4;
        let mut writer = self.shared.lock_writer();
        let store = Arc::clone(&writer.generation.store);
        for (at, &ordinal) in layout.ordinals.iter().enumerate() {
            let Ok(ordinal) = u32::try_from(ordinal) else {
                continue;
            };
            if is_dead(layout.dead, at) || !store.is_live(ordinal) {
                continue;
            }
            let offset = layout.vectors_offset + at as u64 * stride;
            writer
                .pending_locations
                .insert(ordinal, (layout.path.to_path_buf(), offset));
        }
        release_pending_locations(&self.shared, &mut writer)
    }

    /// Stops the field's background work and drops every vector, so that the field holds none of its files open,
    /// mapped or paged. Only a restore that takes the field's index out of the engine does this, while it holds the
    /// index's write lock and no read runs on the index.
    pub(crate) fn release_files(&self) {
        let shared = &self.shared;
        shared.disposed.store(true, Ordering::Release);
        shared.cancel_cold_hold(true);
        wait_for_builds(shared);
        let mut writer = shared.lock_writer();
        writer.job = None;
        writer.placing = None;
        writer.pending_locations.clear();
        writer.generation = Arc::new(Generation::empty(
            &shared.settings,
            shared.hasher.clone(),
            &shared.sequence,
        ));
        shared.publish_held(&writer);
    }

    pub(crate) fn vector_files_in_use(&self) -> Vec<PathBuf> {
        let mut paths = self
            .shared
            .cold_hold()
            .map_or_else(Vec::new, |hold| hold.field.file_paths());
        paths.extend(self.mapped_files_in_use());
        paths
    }

    fn mapped_files_in_use(&self) -> Vec<PathBuf> {
        let generation = self.shared.current();
        let store = &generation.store;
        if store.files().len() == 0 {
            return Vec::new();
        }
        let mut used = vec![false; store.files().len()];
        for ordinal in 0..store.slots() {
            if store.present(ordinal)
                && let Some((file, _)) = store.file_of(ordinal)
                && let Some(slot) = used.get_mut(file)
            {
                *slot = true;
            }
        }
        store
            .files()
            .owners()
            .iter()
            .zip(used)
            .filter(|(_, held)| *held)
            .map(|(file, _)| file.path().to_path_buf())
            .collect()
    }
}

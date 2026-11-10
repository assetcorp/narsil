use super::load::read_graph_parts;
use super::load_source::CheckpointSource;
use crate::error::Result;
use crate::format::manifest_refs::VectorFieldRef;
use crate::vector::cold::{ColdFieldInput, ColdFileInput, ColdGraphPartInput, open_cold_field};
use crate::vector::field::VectorField;

fn lists_a_head_for_every_file(listed: &VectorFieldRef) -> bool {
    !listed.files.is_empty()
        && !listed.graph_parts.is_empty()
        && listed.files.iter().all(|file| file.file.head.is_some())
        && listed.graph_parts.iter().all(|part| part.head.is_some())
}

pub(super) fn open_from_files(
    store: &dyn CheckpointSource,
    field: &VectorField,
    listed: &VectorFieldRef,
) -> Result<bool> {
    let settings = &field.shared.settings;
    if !settings.reads_from_disk() || !lists_a_head_for_every_file(listed) {
        return Ok(false);
    }
    let Some(later) = store.source_for_a_later_read() else {
        return Ok(false);
    };
    let mut files = Vec::with_capacity(listed.files.len());
    for file in &listed.files {
        let Some(path) = store.path_of(&file.file.key)? else {
            return Ok(false);
        };
        files.push(ColdFileInput {
            listed: file.clone(),
            path,
        });
    }
    let mut graph_parts = Vec::with_capacity(listed.graph_parts.len());
    for part in &listed.graph_parts {
        let Some(path) = store.path_of(&part.key)? else {
            return Ok(false);
        };
        graph_parts.push(ColdGraphPartInput {
            listed: part.clone(),
            path,
        });
    }
    let Some(cold) = open_cold_field(settings, ColdFieldInput { files, graph_parts })? else {
        return Ok(false);
    };
    let listed = listed.clone();
    field.open_cold(
        cold,
        Box::new(move || read_graph_parts(later.as_ref(), &listed)),
    )
}

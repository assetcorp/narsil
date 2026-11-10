use std::path::{Path, PathBuf};

use crate::error::{Result, load_failed};
use crate::format::envelope::{HEADER_BYTES, read_header};
use crate::format::graph_part::VECTOR_GRAPH_PART_VECTORS;
use crate::format::manifest_refs::{FileRef, VectorFileRef};
use crate::format::vector_head::{
    FileCodes, GraphPartLayout, codes_span, decode_file_codes, decode_graph_part_head,
    decode_vector_file_head, payload_length_of, require_head_checksum, vector_file_sections,
};
use crate::index::paged::PagedFile;

use super::super::disk::is_dead;
use super::super::settings::VectorSettings;
use super::field::{ColdField, ColdFieldParts, ColdFile, ColdGraphPart};
use super::layout::{graph_of, require_matching_layout};

pub(crate) struct ColdFileInput {
    pub(crate) listed: VectorFileRef,
    pub(crate) path: PathBuf,
}

pub(crate) struct ColdGraphPartInput {
    pub(crate) listed: FileRef,
    pub(crate) path: PathBuf,
}

pub(crate) struct ColdFieldInput {
    pub(crate) files: Vec<ColdFileInput>,
    pub(crate) graph_parts: Vec<ColdGraphPartInput>,
}

fn opened_at_listed_size(path: &Path, listed: &FileRef, what: &str) -> Result<PagedFile> {
    let file = PagedFile::open(path)?;
    let held = file.length()?;
    if held != listed.bytes {
        return load_failed(format!(
            "The {what} \"{}\" holds {held} bytes where the manifest lists {}",
            listed.key, listed.bytes
        ));
    }
    Ok(file)
}

fn read_head(file: &PagedFile, listed: &FileRef) -> Result<Option<Vec<u8>>> {
    let Some(head) = &listed.head else {
        return Ok(None);
    };
    let mut header = [0u8; HEADER_BYTES];
    file.read_into(0, &mut header)?;
    if read_header(&header)?.compressed {
        return Ok(None);
    }
    let inside = head
        .offset
        .checked_add(u64::from(head.length))
        .is_some_and(|end| end <= payload_length_of(listed));
    if !inside {
        return load_failed(format!(
            "The head of the file \"{}\" ends outside its payload",
            listed.key
        ));
    }
    let mut bytes = vec![0u8; head.length as usize];
    file.read_into(HEADER_BYTES as u64 + head.offset, &mut bytes)?;
    require_head_checksum(&bytes, listed)?;
    Ok(Some(bytes))
}

fn codes_of_file(
    file: &PagedFile,
    sections: &[crate::format::paged_segment::head::PagedSection],
    dimension: usize,
    key: &str,
) -> Result<Option<FileCodes>> {
    let Some(span) = codes_span(sections, dimension, key)? else {
        return Ok(None);
    };
    let mut bytes = vec![0u8; span.length];
    file.read_into(HEADER_BYTES as u64 + span.offset, &mut bytes)?;
    decode_file_codes(&bytes, key).map(Some)
}

struct OpenedFiles {
    files: Vec<ColdFile>,
    codes: Option<FileCodes>,
}

fn open_files(
    settings: &VectorSettings,
    inputs: Vec<ColdFileInput>,
) -> Result<Option<OpenedFiles>> {
    let coded = settings.bits() != 0;
    let mut files = Vec::with_capacity(inputs.len());
    let mut codes: Option<FileCodes> = None;
    let mut first = 0u32;
    for input in inputs {
        let ColdFileInput { listed, path } = input;
        let key = listed.file.key.as_str();
        let file = opened_at_listed_size(&path, &listed.file, "vector file")?;
        let Some(head) = read_head(&file, &listed.file)? else {
            return Ok(None);
        };
        let sections = decode_vector_file_head(&head, &listed.file)?;
        let file_codes = codes_of_file(&file, &sections, settings.dimension, key)?;
        if coded {
            let Some(found) = file_codes.filter(|found| found.bits == settings.bits()) else {
                return Ok(None);
            };
            if codes.as_ref().is_some_and(|held| *held != found) {
                return Ok(None);
            }
            codes = Some(found);
        }
        let sections = vector_file_sections(&sections, key, listed.count)?;
        files.push(ColdFile {
            id: listed.id,
            key: listed.file.key.clone(),
            first,
            count: listed.count,
            dead: listed.dead,
            file,
            sections,
        });
        first = first.saturating_add(listed.count);
    }
    Ok(Some(OpenedFiles { files, codes }))
}

struct OpenedParts {
    parts: Vec<ColdGraphPart>,
    first_layout: GraphPartLayout,
}

fn open_parts(inputs: Vec<ColdGraphPartInput>) -> Result<Option<OpenedParts>> {
    let mut parts = Vec::with_capacity(inputs.len());
    let mut first_layout = None;
    for input in inputs {
        let ColdGraphPartInput { listed, path } = input;
        let file = opened_at_listed_size(&path, &listed, "graph part")?;
        let Some(head) = read_head(&file, &listed)? else {
            return Ok(None);
        };
        let Some(layout) = decode_graph_part_head(&head, &listed)? else {
            return Ok(None);
        };
        if layout.levels.length > VECTOR_GRAPH_PART_VECTORS as u64 {
            return load_failed(format!(
                "The node ranges of \"{}\" do not match the field",
                path.display()
            ));
        }
        let levels = file.whole_checked(&layout.levels)?;
        parts.push(ColdGraphPart {
            file,
            levels,
            node_offsets: layout.node_offsets.clone(),
            neighbours: layout.neighbours.clone(),
        });
        first_layout.get_or_insert(layout);
    }
    Ok(first_layout.map(|first_layout| OpenedParts {
        parts,
        first_layout,
    }))
}

fn every_live_vector_holds_a_node(files: &[ColdFile], parts: &[ColdGraphPart]) -> bool {
    files.iter().all(|file| {
        (0..file.count as usize)
            .filter(|&position| !is_dead(file.dead.as_deref(), position))
            .all(|position| {
                let number = file.first as usize + position;
                parts
                    .get(number / VECTOR_GRAPH_PART_VECTORS)
                    .and_then(|part| part.levels.get(number % VECTOR_GRAPH_PART_VECTORS))
                    .is_some_and(|&level| level != 0)
            })
    })
}

pub(crate) fn open_cold_field(
    settings: &VectorSettings,
    input: ColdFieldInput,
) -> Result<Option<ColdField>> {
    let Some(opened) = open_files(settings, input.files)? else {
        return Ok(None);
    };
    let Some(graphed) = open_parts(input.graph_parts)? else {
        return Ok(None);
    };
    let OpenedFiles { files, codes } = opened;
    let OpenedParts {
        parts,
        first_layout,
    } = graphed;
    let total = require_matching_layout(settings.dimension, codes.as_ref(), &files)?;
    let graph = graph_of(&first_layout, total, &parts)?;
    if !every_live_vector_holds_a_node(&files, &parts) {
        return Ok(None);
    }
    Ok(Some(ColdField::new(ColdFieldParts {
        dimension: settings.dimension,
        codes,
        graph,
        files,
        parts,
    })))
}

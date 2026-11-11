use std::path::PathBuf;
use std::ptr;

use crate::config::MAX_DOC_ID_LENGTH;
use crate::error::{Result, load_failed};
use crate::ffi;
use crate::format::graph_part::VECTOR_GRAPH_PART_VECTORS;
use crate::format::paged_segment::head::PagedSection;
use crate::format::vector_head::{FileCodes, VectorFileSections};
use crate::index::paged::PagedFile;
use crate::util::bytes::le_values;
use crate::value::{Value, decode_value};

use super::super::constants::{MAX_DOC_ID_UTF8_BYTES_PER_UNIT, VECTOR_FILE_STRING_HEADER_BYTES};
use super::super::disk::is_dead;

const UINT32_BYTES: u64 = 4;
const FLOAT32_BYTES: usize = 4;
const MAX_ENCODED_ID_BYTES: u64 =
    VECTOR_FILE_STRING_HEADER_BYTES + MAX_DOC_ID_LENGTH as u64 * MAX_DOC_ID_UTF8_BYTES_PER_UNIT;

pub(crate) struct ColdFile {
    pub(crate) id: u64,
    pub(crate) key: String,
    pub(crate) first: u32,
    pub(crate) count: u32,
    pub(crate) dead: Option<Vec<u8>>,
    pub(crate) file: PagedFile,
    pub(crate) sections: VectorFileSections,
}

pub(crate) struct ColdGraphPart {
    pub(crate) file: PagedFile,
    pub(crate) levels: Vec<u8>,
    pub(crate) node_offsets: Vec<u32>,
    pub(crate) neighbours: PagedSection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ColdGraph {
    pub(crate) entry_point: Option<u32>,
    pub(crate) max_layer: u32,
}

pub(crate) struct ColdField {
    dimension: usize,
    total: u32,
    live: u64,
    codes: Option<FileCodes>,
    graph: ColdGraph,
    files: Vec<ColdFile>,
    parts: Vec<ColdGraphPart>,
}

pub(crate) struct ColdFieldParts {
    pub(crate) dimension: usize,
    pub(crate) codes: Option<FileCodes>,
    pub(crate) graph: ColdGraph,
    pub(crate) files: Vec<ColdFile>,
    pub(crate) parts: Vec<ColdGraphPart>,
}

impl ColdField {
    pub(crate) fn new(parts: ColdFieldParts) -> ColdField {
        let ColdFieldParts {
            dimension,
            codes,
            graph,
            files,
            parts,
        } = parts;
        let total = files.last().map_or(0, |file| file.first + file.count);
        let live = files
            .iter()
            .map(|file| {
                (0..file.count as usize)
                    .filter(|&position| !is_dead(file.dead.as_deref(), position))
                    .count() as u64
            })
            .sum();
        ColdField {
            dimension,
            total,
            live,
            codes,
            graph,
            files,
            parts,
        }
    }

    pub(crate) fn dimension(&self) -> usize {
        self.dimension
    }

    pub(crate) fn total(&self) -> u32 {
        self.total
    }

    pub(crate) fn live_count(&self) -> u64 {
        self.live
    }

    pub(crate) fn codes(&self) -> Option<&FileCodes> {
        self.codes.as_ref()
    }

    pub(crate) fn code_bits(&self) -> Option<u8> {
        self.codes.as_ref().map(|codes| codes.bits)
    }

    pub(crate) fn files(&self) -> &[ColdFile] {
        &self.files
    }

    pub(crate) fn resident_bytes(&self) -> usize {
        self.parts
            .iter()
            .map(|part| part.levels.len() + part.node_offsets.len() * size_of::<u32>())
            .sum()
    }

    pub(crate) fn file_paths(&self) -> Vec<PathBuf> {
        self.files
            .iter()
            .map(|file| file.file.path().to_path_buf())
            .chain(self.parts.iter().map(|part| part.file.path().to_path_buf()))
            .collect()
    }

    pub(crate) fn with_core_field<T>(
        &self,
        metric: u32,
        search: impl FnOnce(&ffi::narsil_paged_vector_field) -> T,
    ) -> T {
        let records: Vec<Option<ffi::narsil_page_section>> = self
            .files
            .iter()
            .map(|file| {
                let listed = file
                    .sections
                    .records
                    .as_ref()
                    .filter(|_| self.codes.is_some());
                listed.map(|records| file.file.section(records))
            })
            .collect();
        let files: Vec<ffi::narsil_paged_vector_file> = self
            .files
            .iter()
            .zip(&records)
            .map(|(file, records)| ffi::narsil_paged_vector_file {
                first: file.first,
                count: file.count,
                dead: file.dead.as_ref().map_or(ptr::null(), |dead| dead.as_ptr()),
                dead_bytes: file.dead.as_ref().map_or(0, Vec::len),
                vectors: file.file.section(&file.sections.vectors),
                records: records.as_ref().map_or(ptr::null(), ptr::from_ref),
            })
            .collect();
        let parts: Vec<ffi::narsil_paged_graph_part> = self
            .parts
            .iter()
            .enumerate()
            .map(|(at, part)| ffi::narsil_paged_graph_part {
                first: (at * VECTOR_GRAPH_PART_VECTORS) as u32,
                count: part.levels.len() as u32,
                levels: part.levels.as_ptr(),
                level_count: part.levels.len(),
                node_offsets: part.node_offsets.as_ptr(),
                offset_count: part.node_offsets.len(),
                neighbours: part.file.section(&part.neighbours),
            })
            .collect();
        let centroid = self.codes.as_ref().map(|codes| codes.centroid.as_slice());
        search(&ffi::narsil_paged_vector_field {
            dimension: self.dimension as u32,
            metric,
            total: self.total,
            entry_point: self.graph.entry_point.unwrap_or(0),
            has_entry_point: i32::from(self.graph.entry_point.is_some()),
            max_layer: self.graph.max_layer,
            bits: u32::from(self.code_bits().unwrap_or(0)),
            centroid: centroid.map_or(ptr::null(), <[f32]>::as_ptr),
            centroid_count: centroid.map_or(0, <[f32]>::len),
            files: files.as_ptr(),
            file_count: files.len(),
            parts: parts.as_ptr(),
            part_count: parts.len(),
        })
    }

    fn file_of(&self, number: u32) -> Result<&ColdFile> {
        let after = self.files.partition_point(|file| file.first <= number);
        match after.checked_sub(1).and_then(|at| self.files.get(at)) {
            Some(file) if number - file.first < file.count => Ok(file),
            _ => load_failed(format!(
                "The disk vector field holds no vector numbered {number}"
            )),
        }
    }

    pub(crate) fn is_dead_number(&self, number: u32) -> bool {
        match self.file_of(number) {
            Ok(file) => is_dead(file.dead.as_deref(), (number - file.first) as usize),
            Err(_) => true,
        }
    }

    fn id_in_file(&self, file: &ColdFile, position: u32) -> Result<String> {
        let path = file.file.path().display();
        let slots = file.file.read(
            &file.sections.id_offsets,
            u64::from(position) * UINT32_BYTES,
            UINT32_BYTES * 2,
        )?;
        let start = u32::from_le_bytes([slots[0], slots[1], slots[2], slots[3]]);
        let end = u32::from_le_bytes([slots[4], slots[5], slots[6], slots[7]]);
        let length = match end.checked_sub(start) {
            Some(length) if u64::from(length) <= MAX_ENCODED_ID_BYTES => u64::from(length),
            Some(_) => {
                return load_failed(format!(
                    "Position {position} of \"{path}\" holds an ID longer than a document ID"
                ));
            }
            None => {
                return load_failed(format!(
                    "The ID offsets of \"{path}\" descend at position {position}"
                ));
            }
        };
        let encoded = file
            .file
            .read(&file.sections.doc_ids, u64::from(start), length)?;
        match decode_value(&encoded) {
            Ok(Value::String(id)) => Ok(id),
            _ => load_failed(format!("Position {position} of \"{path}\" holds no ID")),
        }
    }

    pub(crate) fn id_at(&self, number: u32) -> Result<String> {
        let file = self.file_of(number)?;
        self.id_in_file(file, number - file.first)
    }

    fn position_of(&self, file: &ColdFile, doc_id: &str) -> Result<Option<u32>> {
        let mut low = 0u32;
        let mut high = file.count;
        while low < high {
            let middle = low + (high - low) / 2;
            let position = file
                .file
                .read_u32(&file.sections.id_order, u64::from(middle))?;
            if position >= file.count {
                return load_failed(format!(
                    "The ID order of \"{}\" holds position {position}",
                    file.file.path().display()
                ));
            }
            match self.id_in_file(file, position)?.as_str().cmp(doc_id) {
                std::cmp::Ordering::Equal => return Ok(Some(position)),
                std::cmp::Ordering::Less => low = middle + 1,
                std::cmp::Ordering::Greater => high = middle,
            }
        }
        Ok(None)
    }

    pub(crate) fn number_of(&self, doc_id: &str) -> Result<Option<u32>> {
        for file in self.files.iter().rev() {
            if let Some(position) = self.position_of(file, doc_id)?
                && !is_dead(file.dead.as_deref(), position as usize)
            {
                return Ok(Some(file.first + position));
            }
        }
        Ok(None)
    }

    pub(crate) fn vector_into(&self, number: u32, out: &mut [f32]) -> Result<()> {
        let file = self.file_of(number)?;
        let stride = (self.dimension * FLOAT32_BYTES) as u64;
        let bytes = file.file.read(
            &file.sections.vectors,
            u64::from(number - file.first) * stride,
            stride,
        )?;
        for (value, number) in out.iter_mut().zip(le_values(&bytes, f32::from_le_bytes)) {
            *value = number;
        }
        Ok(())
    }

    pub(crate) fn page_failed(
        &self,
        status: ffi::narsil_status,
        fault: &ffi::narsil_page_fault,
    ) -> Option<crate::error::NarsilError> {
        for file in &self.files {
            if file.file.identity() == fault.file {
                let mut sections = vec![&file.sections.vectors];
                sections.extend(file.sections.records.as_ref());
                return Some(file.file.page_failed(status, fault, &sections));
            }
        }
        self.parts
            .iter()
            .find(|part| part.file.identity() == fault.file)
            .map(|part| part.file.page_failed(status, fault, &[&part.neighbours]))
    }
}

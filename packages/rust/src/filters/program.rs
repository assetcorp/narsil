use std::collections::HashMap;

use super::regions::{FieldRegions, field_index, present_bits, source_of};
use super::source::and_into;
use crate::error::Result;
use crate::ffi;
use crate::index::segment::SegmentEntry;
use crate::keyword::workspace::{core_refused, with_workspace};
use crate::pattern::{PatternIndexes, PatternTest, WorkMeter};
use crate::schema::BaseType;

pub(super) struct FilterProgram<'s> {
    entry: &'s SegmentEntry,
    live: Vec<u32>,
    meter: &'s WorkMeter,
    patterns: PatternIndexes<'s>,
    instructions: Vec<u32>,
    numbers: Vec<f64>,
    units: Vec<u16>,
    offsets: Vec<u32>,
    lists: Vec<u32>,
    bitsets: Vec<Vec<u32>>,
    fields: Vec<FieldRegions<'s>>,
    field_ids: HashMap<(String, bool), u32>,
    presents: HashMap<String, Vec<u32>>,
    live_operand: Option<u32>,
}

fn index_of(length: usize) -> u32 {
    length as u32
}

impl<'s> FilterProgram<'s> {
    pub(super) fn new(entry: &'s SegmentEntry, live: Vec<u32>, meter: &'s WorkMeter) -> Self {
        FilterProgram {
            entry,
            live,
            meter,
            patterns: PatternIndexes::new(entry),
            instructions: Vec::new(),
            numbers: Vec::new(),
            units: Vec::new(),
            offsets: vec![0],
            lists: Vec::new(),
            bitsets: Vec::new(),
            fields: Vec::new(),
            field_ids: HashMap::new(),
            presents: HashMap::new(),
            live_operand: None,
        }
    }

    pub(super) fn entry(&self) -> &'s SegmentEntry {
        self.entry
    }

    pub(super) fn live(&self) -> &[u32] {
        &self.live
    }

    pub(super) fn emit(&mut self, opcode: u32, field: u32, operator: u32, operand: u32) {
        self.instructions
            .extend_from_slice(&[opcode, field, operator, operand]);
    }

    pub(super) fn bitset(&mut self, bits: Vec<u32>) {
        let operand = index_of(self.bitsets.len());
        self.bitsets.push(bits);
        self.emit(ffi::NARSIL_FILTER_BITSET, 0, 0, operand);
    }

    pub(super) fn live_bitset(&mut self) {
        let operand = match self.live_operand {
            Some(operand) => operand,
            None => {
                let operand = index_of(self.bitsets.len());
                self.bitsets.push(self.live.clone());
                self.live_operand = Some(operand);
                operand
            }
        };
        self.emit(ffi::NARSIL_FILTER_BITSET, 0, 0, operand);
    }

    pub(super) fn present(&mut self, path: &str, base: BaseType) -> Vec<u32> {
        if let Some(bits) = self.presents.get(path) {
            return bits.clone();
        }
        let mut bits = present_bits(self.entry, path, base);
        and_into(&mut bits, &self.live);
        self.presents.insert(path.to_string(), bits.clone());
        bits
    }

    pub(super) fn holds_sizes(&self, path: &str) -> bool {
        source_of(self.entry).sizes(path).is_some()
    }

    pub(super) fn field(&mut self, path: &str, base: BaseType, size: bool) -> Result<u32> {
        let key = (path.to_string(), size);
        if let Some(&field) = self.field_ids.get(&key) {
            return Ok(field);
        }
        let present = self.present(path, base);
        let index = field_index(self.entry, path, base, size)?;
        let field = index_of(self.fields.len());
        self.fields.push(FieldRegions { present, index });
        self.field_ids.insert(key, field);
        Ok(field)
    }

    pub(super) fn test_numbers(&mut self, field: u32, operator: u32, values: &[f64]) {
        let operand = index_of(self.numbers.len());
        self.numbers.extend_from_slice(values);
        self.emit(ffi::NARSIL_FILTER_TEST, field, operator, operand);
    }

    pub(super) fn test_number_list(&mut self, field: u32, operator: u32, values: &[f64]) {
        let operand = index_of(self.numbers.len());
        self.numbers.push(values.len() as f64);
        self.numbers.extend_from_slice(values);
        self.emit(ffi::NARSIL_FILTER_TEST, field, operator, operand);
    }

    fn push_text(&mut self, text: &str) -> u32 {
        let operand = index_of(self.offsets.len() - 1);
        self.units.extend(text.encode_utf16());
        self.offsets.push(index_of(self.units.len()));
        operand
    }

    pub(super) fn test_text(&mut self, field: u32, operator: u32, text: &str) {
        let operand = self.push_text(text);
        self.emit(ffi::NARSIL_FILTER_TEST, field, operator, operand);
    }

    pub(super) fn test_text_list(&mut self, field: u32, operator: u32, texts: &[&str]) {
        let operand = index_of(self.lists.len() / 2);
        let first = index_of(self.offsets.len() - 1);
        for text in texts {
            self.push_text(text);
        }
        self.lists
            .extend_from_slice(&[first, index_of(texts.len())]);
        self.emit(ffi::NARSIL_FILTER_TEST, field, operator, operand);
    }

    pub(super) fn pattern_into(
        &mut self,
        path: &str,
        test: &PatternTest<'_>,
        into: &mut [u32],
    ) -> Result<()> {
        self.patterns.match_into(path, test, self.meter, into)
    }

    pub(super) fn evaluate(self) -> Result<Vec<u32>> {
        let words = self.live.len();
        if words == 0 {
            return Ok(Vec::new());
        }
        let fields: Vec<ffi::narsil_filter_field> =
            self.fields.iter().map(FieldRegions::native).collect();
        let bitsets: Vec<ffi::narsil_filter_bits> = self
            .bitsets
            .iter()
            .map(|bits| ffi::narsil_filter_bits {
                words: bits.as_ptr(),
                count: bits.len(),
            })
            .collect();
        let program = ffi::narsil_filter_program {
            plan: self.instructions.as_ptr(),
            plan_words: self.instructions.len(),
            numbers: self.numbers.as_ptr(),
            number_count: self.numbers.len(),
            units: self.units.as_ptr(),
            unit_count: self.units.len(),
            offsets: self.offsets.as_ptr(),
            offset_count: self.offsets.len(),
            lists: self.lists.as_ptr(),
            list_words: self.lists.len(),
            bitsets: bitsets.as_ptr(),
            bitset_count: bitsets.len(),
            fields: fields.as_ptr(),
            field_count: fields.len(),
            live: ffi::narsil_filter_bits {
                words: self.live.as_ptr(),
                count: words,
            },
        };
        let mut into = vec![0u32; words];
        let status = with_workspace(|workspace| {
            Ok(unsafe {
                ffi::narsil_evaluate_filter(workspace, &program, into.as_mut_ptr(), into.len())
            })
        })?;
        match status {
            ffi::NARSIL_OK => Ok(into),
            status => Err(core_refused("a filter", status)),
        }
    }
}

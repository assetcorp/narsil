use std::cmp::Ordering;
use std::collections::HashMap;
use std::str::Chars;
use std::sync::OnceLock;

use super::fold_table::{FOLD_ENTRY_COUNT, MULTI_FOLDS, SINGLE_FOLDS};

const BASE36: u32 = 36;
const LONGEST_FOLD: usize = 3;
const ASCII_LIMIT: u32 = 0x80;
const ASCII_UPPER_A: u32 = 0x41;
const ASCII_UPPER_Z: u32 = 0x5a;
const ASCII_CASE_OFFSET: u32 = 0x20;

struct FoldTable {
    single: HashMap<u32, u32>,
    multi: HashMap<u32, Vec<u32>>,
}

fn base36(text: &str) -> i64 {
    i64::from_str_radix(text, BASE36).unwrap_or(0)
}

fn code_point(value: i64) -> u32 {
    u32::try_from(value).unwrap_or(0)
}

fn decoded_table() -> FoldTable {
    let mut single = HashMap::with_capacity(FOLD_ENTRY_COUNT);
    let mut source = 0i64;
    for entry in SINGLE_FOLDS.split(';').filter(|entry| !entry.is_empty()) {
        let (delta, offset) = entry.split_once(',').unwrap_or((entry, "0"));
        source += base36(delta);
        single.insert(code_point(source), code_point(source + base36(offset)));
    }
    let mut multi = HashMap::new();
    let mut source = 0i64;
    for entry in MULTI_FOLDS.split(';').filter(|entry| !entry.is_empty()) {
        let mut parts = entry.split(',');
        source += base36(parts.next().unwrap_or("0"));
        let folded: Vec<u32> = parts.map(|part| code_point(base36(part))).collect();
        multi.insert(code_point(source), folded);
    }
    FoldTable { single, multi }
}

fn table() -> &'static FoldTable {
    static TABLE: OnceLock<FoldTable> = OnceLock::new();
    TABLE.get_or_init(decoded_table)
}

struct FoldedCodePoints<'a> {
    chars: Chars<'a>,
    pending: [u32; LONGEST_FOLD],
    pending_length: usize,
    pending_at: usize,
    table: &'static FoldTable,
}

impl<'a> FoldedCodePoints<'a> {
    fn new(text: &'a str) -> FoldedCodePoints<'a> {
        FoldedCodePoints {
            chars: text.chars(),
            pending: [0; LONGEST_FOLD],
            pending_length: 0,
            pending_at: 0,
            table: table(),
        }
    }
}

impl Iterator for FoldedCodePoints<'_> {
    type Item = u32;

    fn next(&mut self) -> Option<u32> {
        if self.pending_at < self.pending_length {
            let folded = self.pending[self.pending_at];
            self.pending_at += 1;
            return Some(folded);
        }
        let point = self.chars.next()? as u32;
        if point < ASCII_LIMIT {
            return Some(match point {
                ASCII_UPPER_A..=ASCII_UPPER_Z => point + ASCII_CASE_OFFSET,
                _ => point,
            });
        }
        if let Some(&folded) = self.table.single.get(&point) {
            return Some(folded);
        }
        let Some(expansion) = self.table.multi.get(&point) else {
            return Some(point);
        };
        let length = expansion.len().min(LONGEST_FOLD);
        self.pending[..length].copy_from_slice(&expansion[..length]);
        self.pending_length = length;
        self.pending_at = 1;
        expansion.first().copied()
    }
}

fn common_prefix_bytes(left: &str, right: &str) -> usize {
    let mut length = 0;
    for (one, other) in left.chars().zip(right.chars()) {
        if one != other {
            break;
        }
        length += one.len_utf8();
    }
    length
}

pub(crate) fn compare_case_folded(left: &str, right: &str) -> Ordering {
    let start = common_prefix_bytes(left, right);
    let mut one = FoldedCodePoints::new(&left[start..]);
    let mut other = FoldedCodePoints::new(&right[start..]);
    loop {
        match (one.next(), other.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(first), Some(second)) if first != second => return first.cmp(&second),
            _ => {}
        }
    }
}

pub(crate) fn folded_code_points(text: &str) -> Box<[u32]> {
    FoldedCodePoints::new(text).collect()
}

pub(crate) fn compare_sort_strings(left: &str, right: &str) -> Ordering {
    compare_case_folded(left, right).then_with(|| left.cmp(right))
}

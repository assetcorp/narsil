use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::OnceLock;

use super::fold_table::{MULTI_FOLDS, SINGLE_FOLDS};

const PAGE_BITS: u32 = 8;
const PAGE_SLOTS: usize = 1 << PAGE_BITS;
const PAGE_COUNT: usize = 0x11_0000 >> PAGE_BITS;
const EMPTY_PAGE: u16 = 0;
const MULTI_FLAG: u32 = 0x8000_0000;
const UNFOLDED: u32 = 0;
const ASCII_LIMIT: u32 = 0x80;
const ASCII_UPPER_FIRST: u32 = 0x41;
const ASCII_UPPER_LAST: u32 = 0x5a;
const ASCII_CASE_OFFSET: u32 = 0x20;
const FOLD_RADIX: u32 = 36;
const MAX_FOLD_CODE_POINTS: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Folded {
    points: [u32; MAX_FOLD_CODE_POINTS],
    length: u8,
}

impl Folded {
    fn single(code_point: u32) -> Folded {
        Folded {
            points: [code_point, 0, 0],
            length: 1,
        }
    }

    pub(crate) fn as_slice(&self) -> &[u32] {
        &self.points[..self.length as usize]
    }

    pub(crate) fn len(&self) -> usize {
        self.length as usize
    }
}

struct FoldTables {
    pages: Vec<u16>,
    slots: Vec<u32>,
    multi: Vec<Folded>,
    sources: HashMap<u32, Vec<u32>>,
}

fn parse_number(text: &str) -> i64 {
    i64::from_str_radix(text, FOLD_RADIX).unwrap_or(0)
}

impl FoldTables {
    fn build() -> FoldTables {
        let mut tables = FoldTables {
            pages: vec![EMPTY_PAGE; PAGE_COUNT],
            slots: Vec::new(),
            multi: Vec::new(),
            sources: HashMap::new(),
        };
        let mut source: i64 = 0;
        for entry in SINGLE_FOLDS.split(';').filter(|entry| !entry.is_empty()) {
            let mut parts = entry.split(',');
            source += parse_number(parts.next().unwrap_or("0"));
            let target = source + parse_number(parts.next().unwrap_or("0"));
            tables.place(source as u32, target as u32 + 1);
            tables
                .sources
                .entry(target as u32)
                .or_default()
                .push(source as u32);
        }
        source = 0;
        for entry in MULTI_FOLDS.split(';').filter(|entry| !entry.is_empty()) {
            let mut parts = entry.split(',');
            source += parse_number(parts.next().unwrap_or("0"));
            let mut folded = Folded {
                points: [0; MAX_FOLD_CODE_POINTS],
                length: 0,
            };
            for part in parts.take(MAX_FOLD_CODE_POINTS) {
                folded.points[folded.length as usize] = parse_number(part) as u32;
                folded.length += 1;
            }
            let index = tables.multi.len() as u32;
            tables.multi.push(folded);
            tables.place(source as u32, MULTI_FLAG | index);
        }
        tables
    }

    fn place(&mut self, code_point: u32, slot: u32) {
        let page = (code_point >> PAGE_BITS) as usize;
        if page >= PAGE_COUNT {
            return;
        }
        if self.pages[page] == EMPTY_PAGE {
            self.slots.extend(std::iter::repeat_n(UNFOLDED, PAGE_SLOTS));
            self.pages[page] = (self.slots.len() / PAGE_SLOTS) as u16;
        }
        let base = (self.pages[page] as usize - 1) * PAGE_SLOTS;
        self.slots[base + (code_point as usize & (PAGE_SLOTS - 1))] = slot;
    }

    fn slot(&self, code_point: u32) -> u32 {
        let page = (code_point >> PAGE_BITS) as usize;
        match self.pages.get(page) {
            Some(&EMPTY_PAGE) | None => UNFOLDED,
            Some(&index) => {
                let base = (index as usize - 1) * PAGE_SLOTS;
                self.slots[base + (code_point as usize & (PAGE_SLOTS - 1))]
            }
        }
    }
}

fn tables() -> &'static FoldTables {
    static TABLES: OnceLock<FoldTables> = OnceLock::new();
    TABLES.get_or_init(FoldTables::build)
}

pub(crate) fn fold(code_point: u32) -> Folded {
    if code_point < ASCII_LIMIT {
        if (ASCII_UPPER_FIRST..=ASCII_UPPER_LAST).contains(&code_point) {
            return Folded::single(code_point + ASCII_CASE_OFFSET);
        }
        return Folded::single(code_point);
    }
    let tables = tables();
    let slot = tables.slot(code_point);
    if slot == UNFOLDED {
        return Folded::single(code_point);
    }
    if slot & MULTI_FLAG != 0 {
        return tables
            .multi
            .get((slot & !MULTI_FLAG) as usize)
            .copied()
            .unwrap_or_else(|| Folded::single(code_point));
    }
    Folded::single(slot - 1)
}

pub(crate) fn append_fold(code_point: u32, out: &mut Vec<u32>) {
    let folded = fold(code_point);
    out.extend_from_slice(folded.as_slice());
}

pub(crate) fn single_fold_sources(folded: u32) -> &'static [u32] {
    tables().sources.get(&folded).map_or(&[], Vec::as_slice)
}

pub(crate) fn is_fold_target(code_point: u32) -> bool {
    !single_fold_sources(code_point).is_empty()
}

struct FoldCursor<'a> {
    chars: std::str::Chars<'a>,
    pending: Folded,
    at: u8,
}

impl<'a> FoldCursor<'a> {
    fn new(text: &'a str) -> FoldCursor<'a> {
        FoldCursor {
            chars: text.chars(),
            pending: Folded {
                points: [0; MAX_FOLD_CODE_POINTS],
                length: 0,
            },
            at: 0,
        }
    }

    fn next_folded(&mut self) -> Option<u32> {
        if self.at < self.pending.length {
            let code_point = self.pending.points[self.at as usize];
            self.at += 1;
            return Some(code_point);
        }
        let folded = fold(self.chars.next()? as u32);
        self.pending = folded;
        self.at = 1;
        Some(folded.points[0])
    }
}

pub(crate) fn compare_case_folded(left: &str, right: &str) -> Ordering {
    let shared = left
        .char_indices()
        .zip(right.chars())
        .find(|((_, a), b)| a != b)
        .map_or(left.len().min(right.len()), |((at, _), _)| at);
    let mut left_cursor = FoldCursor::new(left.get(shared..).unwrap_or(""));
    let mut right_cursor = FoldCursor::new(right.get(shared..).unwrap_or(""));
    loop {
        match (left_cursor.next_folded(), right_cursor.next_folded()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(a), Some(b)) if a != b => return a.cmp(&b),
            _ => {}
        }
    }
}

pub(crate) fn compare_sort_strings(left: &str, right: &str) -> Ordering {
    compare_case_folded(left, right).then_with(|| left.cmp(right))
}

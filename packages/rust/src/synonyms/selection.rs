use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};

use super::constants::{SYNONYM_EXPANSION_CACHE_ENTRIES, SYNONYMS_ADDED_PER_QUERY};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::ffi;
use crate::native::status::query_accepted;

type Selected = Arc<[(String, Vec<String>)]>;

#[derive(Default)]
pub(super) struct SynonymTable {
    pub(super) tokens: Vec<u8>,
    pub(super) offsets: Vec<u32>,
    pub(super) rule_start: Vec<u32>,
    pub(super) rule_source: Vec<i32>,
    pub(super) rule_tokens: Vec<u32>,
    pub(super) token_start: Vec<u32>,
    pub(super) token_rules: Vec<u32>,
}

pub(super) struct SynonymSelection {
    table: SynonymTable,
    cache: RwLock<HashMap<Vec<String>, Selected>>,
}

fn query_too_long() -> NarsilError {
    NarsilError::new(
        ErrorCode::CONFIG_INVALID,
        "The synonym query exceeds the text layout",
    )
}

pub(super) fn table_index(value: usize) -> Result<u32> {
    u32::try_from(value).map_err(|_| query_too_long())
}

struct Expanded {
    queries: [u32; SYNONYMS_ADDED_PER_QUERY],
    starts: [u32; SYNONYMS_ADDED_PER_QUERY + 1],
    tokens: [u32; SYNONYMS_ADDED_PER_QUERY],
    count: u32,
}

impl SynonymSelection {
    pub(super) fn new(table: SynonymTable) -> SynonymSelection {
        SynonymSelection {
            table,
            cache: RwLock::new(HashMap::new()),
        }
    }

    fn token(&self, rank: u32) -> String {
        let offsets = &self.table.offsets;
        let start = offsets.get(rank as usize).copied().unwrap_or(0) as usize;
        let end = offsets.get(rank as usize + 1).copied().unwrap_or(0) as usize;
        String::from_utf8_lossy(self.table.tokens.get(start..end).unwrap_or_default()).into_owned()
    }

    fn expand(&self, tokens: &[&str]) -> Result<Expanded> {
        let mut units: Vec<u16> = Vec::new();
        let mut starts: Vec<u32> = Vec::with_capacity(tokens.len() + 1);
        starts.push(0);
        for token in tokens {
            units.extend(token.encode_utf16());
            starts.push(table_index(units.len())?);
        }
        let table = &self.table;
        let raw = ffi::narsil_synonym_table {
            tokens: table.tokens.as_ptr(),
            token_bytes: table.tokens.len(),
            offsets: table.offsets.as_ptr(),
            token_count: table.offsets.len() - 1,
            rule_start: table.rule_start.as_ptr(),
            rule_source: table.rule_source.as_ptr(),
            rule_count: table.rule_source.len(),
            rule_tokens: table.rule_tokens.as_ptr(),
            rule_token_count: table.rule_tokens.len(),
            token_start: table.token_start.as_ptr(),
            token_rules: table.token_rules.as_ptr(),
            token_rule_count: table.token_rules.len(),
        };
        let request = ffi::narsil_synonym_request {
            table: &raw,
            units: units.as_ptr(),
            unit_count: units.len(),
            starts: starts.as_ptr(),
            query_count: tokens.len(),
        };
        let mut expanded = Expanded {
            queries: [0; SYNONYMS_ADDED_PER_QUERY],
            starts: [0; SYNONYMS_ADDED_PER_QUERY + 1],
            tokens: [0; SYNONYMS_ADDED_PER_QUERY],
            count: 0,
        };
        let output = ffi::narsil_synonym_output {
            queries: expanded.queries.as_mut_ptr(),
            query_capacity: expanded.queries.len(),
            starts: expanded.starts.as_mut_ptr(),
            start_capacity: expanded.starts.len(),
            tokens: expanded.tokens.as_mut_ptr(),
            token_capacity: expanded.tokens.len(),
        };
        let mut count = 0u32;
        let status = unsafe { ffi::narsil_expand_synonyms(&request, &output, &mut count) };
        query_accepted("a synonym expansion", status)?;
        expanded.count = count;
        Ok(expanded)
    }

    fn selected(&self, tokens: &[&str]) -> Result<Selected> {
        let expanded = self.expand(tokens)?;
        let groups = (expanded.count as usize).min(SYNONYMS_ADDED_PER_QUERY);
        let mut selected = Vec::with_capacity(groups);
        for group in 0..groups {
            let query = expanded.queries[group] as usize;
            let start = expanded.starts[group] as usize;
            let end = (expanded.starts[group + 1] as usize).min(SYNONYMS_ADDED_PER_QUERY);
            let synonyms = expanded
                .tokens
                .get(start..end)
                .unwrap_or_default()
                .iter()
                .map(|&rank| self.token(rank))
                .collect();
            let token = tokens.get(query).copied().unwrap_or_default();
            selected.push((token.to_string(), synonyms));
        }
        Ok(selected.into())
    }

    pub(super) fn select(&self, query_tokens: &[String]) -> Result<Vec<(String, Vec<String>)>> {
        let mut seen: HashSet<&str> = HashSet::new();
        let tokens: Vec<&str> = query_tokens
            .iter()
            .map(String::as_str)
            .filter(|token| seen.insert(token))
            .collect();
        let key: Vec<String> = tokens.iter().map(|token| token.to_string()).collect();
        let cached = self
            .cache
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&key)
            .cloned();
        if let Some(found) = cached {
            return Ok(found.to_vec());
        }
        let found = self.selected(&tokens)?;
        let mut held = self
            .cache
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if held.len() >= SYNONYM_EXPANSION_CACHE_ENTRIES {
            held.clear();
        }
        held.insert(key, found.clone());
        Ok(found.to_vec())
    }
}

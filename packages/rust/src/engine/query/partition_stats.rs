use std::collections::{BTreeMap, BTreeSet};

use super::bm25::merged_bm25;
use super::confined::PartitionQuery;
use super::documents::QuerySnapshots;
use super::fulltext::{TextSearch, analyse_text, partition_terms};
use super::params::QueryParams;
use crate::engine::index::IndexState;
use crate::error::Result;
use crate::search::stats::partition_frequency;

/// The matching options of a query whose statistics a cluster coordinator collects, which decide the tokens that a
/// prefix completion, a partial-word search, and typo tolerance reach.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct StatsExpansion {
    /// The typo tolerance of the query.
    pub tolerance: Option<u32>,
    /// The number of leading characters that a typo must leave alone.
    pub prefix_length: Option<u32>,
    /// Whether the query completes its last word.
    pub prefix: Option<bool>,
    /// Whether the query searches parts of words.
    pub partial_words: Option<bool>,
    /// Whether the query matches its words exactly.
    pub exact: Option<bool>,
    /// The fields that the query searches.
    pub fields: Option<Vec<String>>,
}

/// The BM25 statistics of some partitions of an index for one query, which a cluster coordinator sums across every
/// data node before it scores the query.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PartitionStatistics {
    /// The live documents of the partitions.
    pub total_documents: u64,
    /// The live documents that hold each token that the query reaches, leaving out a token that no document holds.
    pub doc_frequencies: BTreeMap<String, u64>,
    /// The summed length of each field across those documents.
    pub total_field_lengths: BTreeMap<String, u64>,
    /// Each token that a prefix completion or a partial-word search reached.
    pub expanded: Vec<String>,
}

fn stats_params(terms: &[String], expansion: Option<&StatsExpansion>) -> QueryParams {
    let mut params = QueryParams {
        term: Some(terms.join(" ")),
        ..QueryParams::default()
    };
    if let Some(expansion) = expansion {
        params.tolerance = expansion.tolerance;
        params.prefix_length = expansion.prefix_length;
        params.prefix = expansion.prefix;
        params.partial_words = expansion.partial_words;
        params.exact = expansion.exact;
        params.fields = expansion.fields.clone();
    }
    params
}

fn reaches_beyond_its_words(params: &QueryParams) -> bool {
    params.exact != Some(true)
        && (params.prefix == Some(true) || params.partial_words == Some(true))
}

pub(crate) fn collect_partition_stats(
    index: &IndexState,
    confinement: &PartitionQuery,
    terms: &[String],
    expansion: Option<&StatsExpansion>,
    tokens: &[String],
) -> Result<PartitionStatistics> {
    let snapshots = QuerySnapshots::confined(index, Some(confinement))?;
    let params = stats_params(terms, expansion);
    let mut reached: BTreeSet<String> = tokens.iter().cloned().collect();
    let mut expanded = BTreeSet::new();
    if let Some(text) = analyse_text(index, &snapshots.layout, &params)? {
        let bm25 = merged_bm25(None, None);
        let search = TextSearch {
            params: &params,
            text: &text,
            bm25: &bm25,
            global: None,
            collect: false,
            without_hits: false,
        };
        let mut words: BTreeSet<&str> = text.tokens.iter().map(String::as_str).collect();
        for phrase in &text.phrases {
            words.extend(phrase.tokens.iter().map(String::as_str));
        }
        for (_, synonyms) in &text.expansion.synonyms {
            words.extend(synonyms.iter().map(String::as_str));
        }
        let expands = reaches_beyond_its_words(&params);
        reached.extend(text.tokens.iter().cloned());
        for snapshot in &snapshots.partitions {
            for term in partition_terms(snapshot, &search)? {
                if expands && !words.contains(term.as_str()) {
                    expanded.insert(term.clone());
                }
                reached.insert(term);
            }
        }
    }
    let mut stats = PartitionStatistics {
        expanded: expanded.into_iter().collect(),
        ..PartitionStatistics::default()
    };
    let mut field_totals: BTreeMap<String, f64> = BTreeMap::new();
    for snapshot in &snapshots.partitions {
        stats.total_documents += snapshot.stats.documents;
        for (field, total) in &snapshot.stats.field_totals {
            *field_totals.entry(field.clone()).or_insert(0.0) += total;
        }
    }
    stats.total_field_lengths = field_totals
        .into_iter()
        .map(|(field, total)| (field, total.max(0.0).round() as u64))
        .collect();
    for term in reached {
        let mut documents = 0u64;
        for snapshot in &snapshots.partitions {
            documents += partition_frequency(snapshot, &term)?;
        }
        if documents > 0 {
            stats.doc_frequencies.insert(term, documents);
        }
    }
    Ok(stats)
}

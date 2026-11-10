use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet, HashMap};

use super::lookup::{TermMatch, live_document_frequency, lookup, typo_matches};
use super::query::{KeywordQuery, TermGroup};
use crate::error::Result;
use crate::index::partition::PartitionSnapshot;
use crate::index::segment::SegmentEntry;

/// The statistics that every segment of a partition scores one query with, so that a document scores the same
/// whichever segment holds it.
#[derive(Clone, Debug, Default)]
pub(crate) struct QueryStats {
    pub(crate) total_documents: f64,
    pub(crate) averages: BTreeMap<String, f64>,
    pub(crate) frequencies: HashMap<String, f64>,
}

impl QueryStats {
    pub(crate) fn frequency(&self, token: &str) -> f64 {
        self.frequencies.get(token).copied().unwrap_or(0.0)
    }

    pub(crate) fn average(&self, field: &str) -> f64 {
        self.averages.get(field).copied().unwrap_or(1.0)
    }
}

/// Returns the tokens that a query term reaches in one segment through typos, in code point order, leaving out the
/// group's own token and its synonyms, which the group scores itself.
pub(crate) fn typo_tokens_for<'a>(
    entry: &'a SegmentEntry,
    token: &'a str,
    group: Option<&TermGroup>,
    query: &KeywordQuery<'_>,
) -> Result<Vec<TermMatch<'a>>> {
    match group {
        Some(group) => {
            if !group.typo_matches || query.exact || query.tolerance == 0 {
                return Ok(Vec::new());
            }
            let mut matches = typo_matches(entry, token, query.tolerance, query.prefix_length)?;
            matches.retain(|found| found.token != token && !group.has_synonym(&found.token));
            Ok(matches)
        }
        None if !query.exact => typo_matches(entry, token, query.tolerance, query.prefix_length),
        None => Ok(lookup(entry, token)?
            .map(|list| {
                vec![TermMatch {
                    token: Cow::Borrowed(token),
                    list,
                }]
            })
            .unwrap_or_default()),
    }
}

/// Returns every term that a query can reach in one partition: its tokens, the members and synonyms of their
/// groups, the tokens of its phrases, and the words that its typo tolerance reaches.
pub(crate) fn candidate_terms(
    snapshot: &PartitionSnapshot,
    query: &KeywordQuery<'_>,
) -> Result<BTreeSet<String>> {
    let mut terms: BTreeSet<String> = BTreeSet::new();
    for phrase in query.phrases {
        terms.extend(phrase.tokens.iter().cloned());
    }
    for token in query.tokens {
        let group = query.group_of(token);
        if let Some(group) = group {
            terms.extend(group.members.iter().map(|member| member.token.clone()));
            terms.extend(group.synonyms.iter().flatten().cloned());
        }
        if group.is_none() && (query.exact || query.tolerance == 0) {
            terms.insert(token.clone());
            continue;
        }
        for entry in &snapshot.segments {
            for found in typo_tokens_for(entry, token, group, query)? {
                terms.insert(found.token.into_owned());
            }
        }
    }
    Ok(terms)
}

/// Returns the number of live documents of a partition that hold `term`.
pub(crate) fn partition_frequency(snapshot: &PartitionSnapshot, term: &str) -> Result<u64> {
    let mut total = 0u64;
    for entry in &snapshot.segments {
        total += live_document_frequency(entry, term)?;
    }
    Ok(total)
}

/// Returns the statistics of a partition for one query: its live documents, each field's average length, and the
/// number of live documents that hold each term the query can reach.
pub(crate) fn partition_query_stats(
    snapshot: &PartitionSnapshot,
    query: &KeywordQuery<'_>,
) -> Result<QueryStats> {
    let mut frequencies = HashMap::new();
    for term in candidate_terms(snapshot, query)? {
        let total = partition_frequency(snapshot, &term)?;
        if total > 0 {
            frequencies.insert(term, total as f64);
        }
    }
    let documents = snapshot.stats.documents;
    let averages = snapshot
        .stats
        .field_totals
        .iter()
        .filter(|_| documents > 0)
        .map(|(field, total)| (field.clone(), total / documents as f64))
        .collect();
    Ok(QueryStats {
        total_documents: documents as f64,
        averages,
        frequencies,
    })
}

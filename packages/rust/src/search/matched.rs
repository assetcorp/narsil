use super::lookup::{TermList, lookup};
use super::phrase::{PhraseWork, match_phrases};
use super::plan::{field_names, segment_pool};
use super::query::{GroupMember, KeywordQuery, TermGroup};
use super::stats::typo_tokens_for;
use crate::error::Result;
use crate::index::partition::PartitionSnapshot;
use crate::index::segment::{SegmentEntry, bit_is_set};

const BITS_PER_WORD: u32 = 32;

struct Marker<'a> {
    entry: &'a SegmentEntry,
    searchable: Vec<bool>,
    partial: Vec<bool>,
    filter: Option<&'a [u32]>,
    words: Vec<u32>,
}

impl Marker<'_> {
    fn mark(&mut self, document: u32, field: u16, accepts: impl Fn(&Self, usize) -> bool) {
        let field = usize::from(field);
        if document >= self.entry.capacity()
            || !self.searchable.get(field).copied().unwrap_or(false)
            || !accepts(self, field)
            || self.entry.is_removed(document)
            || self
                .filter
                .is_some_and(|filter| !bit_is_set(filter, document))
        {
            return;
        }
        if let Some(word) = self.words.get_mut((document / BITS_PER_WORD) as usize) {
            *word |= 1 << (document % BITS_PER_WORD);
        }
    }

    fn mark_list(
        &mut self,
        list: TermList<'_>,
        accepts: impl Fn(&Self, usize) -> bool + Copy,
    ) -> Result<()> {
        match list {
            TermList::Tail(postings) => {
                for posting in postings {
                    self.mark(posting.document, posting.field, accepts);
                }
            }
            TermList::Pool { start, length, .. } => {
                let Some(pool) = segment_pool(self.entry) else {
                    return Ok(());
                };
                let end = start.saturating_add(length);
                let documents = pool.documents.get(start..end).unwrap_or(&[]);
                let fields = pool.fields.get(start..end).unwrap_or(&[]);
                for (document, field) in documents.iter().zip(fields) {
                    self.mark(*document, *field, accepts);
                }
            }
            TermList::Paged { segment, token, .. } => {
                let Some(postings) = segment.paged_list(token)? else {
                    return Ok(());
                };
                for (document, field) in postings.documents.iter().zip(&postings.fields) {
                    self.mark(*document, *field, accepts);
                }
            }
        }
        Ok(())
    }

    fn mark_member(&mut self, group: &TermGroup, member: &GroupMember) -> Result<()> {
        let accepts = |marker: &Self, field: usize| {
            let factor = match marker.partial.get(field).copied().unwrap_or(false) {
                true => member.partial_factor,
                false => member.factor,
            };
            factor > 0.0
        };
        let synonyms = group
            .synonyms
            .as_deref()
            .filter(|_| member.token == group.token)
            .unwrap_or(&[]);
        let tokens =
            std::iter::once(member.token.as_str()).chain(synonyms.iter().map(String::as_str));
        for token in tokens {
            if let Some(list) = lookup(self.entry, token) {
                self.mark_list(list, accepts)?;
            }
        }
        Ok(())
    }
}

fn any_field(_: &Marker<'_>, _: usize) -> bool {
    true
}

/// Marks, in each segment, the documents that a keyword search would score, without scoring them: the bitset
/// holds the same documents that the native core collects for the query. Where `filters` holds the filter's bitset
/// over each segment, the bitsets hold the documents that it accepts alone.
pub(crate) fn match_partition(
    snapshot: &PartitionSnapshot,
    query: &KeywordQuery<'_>,
    filters: Option<&[Vec<u32>]>,
    work: &mut dyn PhraseWork,
) -> Result<Vec<Option<Vec<u32>>>> {
    let mut matched = vec![None; snapshot.segments.len()];
    if query.tokens.is_empty() && query.phrases.is_empty() {
        return Ok(matched);
    }
    for (at, entry) in snapshot.segments.iter().enumerate() {
        if entry.live_count() == 0 {
            continue;
        }
        let filter = filters
            .and_then(|filters| filters.get(at))
            .map(Vec::as_slice);
        let names = field_names(entry);
        let searchable: Vec<bool> = names
            .iter()
            .map(|name| query.fields.is_none_or(|fields| fields.contains(name)))
            .collect();
        let phrase_matches = match query.phrases.is_empty() {
            true => None,
            false => {
                let marks: Vec<u8> = searchable.iter().map(|mark| u8::from(*mark)).collect();
                match match_phrases(entry, query.phrases, &marks, filter, work)? {
                    Some(found) if found.matched.iter().any(|&word| word != 0) => Some(found),
                    _ => continue,
                }
            }
        };
        let mut marker = Marker {
            entry,
            searchable,
            partial: names
                .iter()
                .map(|name| query.partial_fields.contains(name))
                .collect(),
            filter: phrase_matches
                .as_ref()
                .map(|found| found.matched.as_slice())
                .or(filter),
            words: vec![0; (entry.capacity() as usize).div_ceil(BITS_PER_WORD as usize)],
        };
        for token in query.tokens {
            let group = query.group_of(token);
            for found in typo_tokens_for(entry, token, group, query) {
                marker.mark_list(found.list, any_field)?;
            }
            if let Some(group) = group {
                for member in &group.members {
                    marker.mark_member(group, member)?;
                }
            }
        }
        for phrase in phrase_matches.iter().flat_map(|found| &found.rows) {
            for row in &phrase.rows {
                marker.mark(row.document, row.field, any_field);
            }
        }
        matched[at] = Some(marker.words);
    }
    Ok(matched)
}

use std::sync::Arc;

use super::index::IndexState;
use crate::analysis::Analyser;
use crate::config::{SynonymRule, synonym_rules_payload};
use crate::error::Result;
use crate::synonyms::lookup::SynonymLookup;
use crate::synonyms::rules::validate_synonym_rules;

/// The synonym set of an index as its caller gave it, with the lookup that its searches read.
#[derive(Default)]
pub(crate) struct SynonymSet {
    pub(crate) rules: Vec<SynonymRule>,
    pub(crate) lookup: Option<Arc<SynonymLookup>>,
}

/// Checks a synonym set and builds its lookup under `analyser`. With `strict_words`, a word that analyses to no
/// token or to several fails the set, as a set that a caller gives does; a stored set skips that word instead.
pub(crate) fn prepare_synonyms(
    rules: Option<&[SynonymRule]>,
    analyser: &Analyser,
    strict_words: bool,
    source: &str,
) -> Result<SynonymSet> {
    let Some(rules) = rules.filter(|rules| !rules.is_empty()) else {
        return Ok(SynonymSet::default());
    };
    validate_synonym_rules(rules, source)?;
    let strict = strict_words.then_some(source);
    let lookup = SynonymLookup::build(rules, analyser, strict)?;
    Ok(SynonymSet {
        rules: rules.to_vec(),
        lookup: lookup.map(Arc::new),
    })
}

/// Replaces the synonym set of an index, so that every later search expands its terms through the new set. A
/// durable index records the new set in its metadata file first, and keeps its old set where that write fails.
pub(crate) fn update_synonyms(index: &IndexState, rules: &[SynonymRule]) -> Result<()> {
    let _writer = index.lock_writes()?;
    let prepared = prepare_synonyms(Some(rules), &index.analyser(), true, "")?;
    if let Some(log) = index.log() {
        let mut metadata = log.metadata(index);
        metadata.synonyms =
            (!prepared.rules.is_empty()).then(|| synonym_rules_payload(&prepared.rules));
        log.write_recorded(metadata)?;
    }
    index.replace_synonyms(prepared);
    Ok(())
}

/// Returns the synonym set of an index, or an empty list where it holds none.
pub(crate) fn synonym_rules(index: &IndexState) -> Vec<SynonymRule> {
    index.synonym_set().rules.clone()
}

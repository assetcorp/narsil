use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::{Arc, RwLock};

use super::constants::{SYNONYM_EXPANSION_CACHE_ENTRIES, SYNONYMS_ADDED_PER_QUERY};
use crate::analysis::{Analyser, TokenOptions};
use crate::config::SynonymRule;
use crate::error::{ErrorCode, NarsilError, Result};

#[derive(Clone)]
enum AnalysedWord {
    Token(String),
    Count(usize),
}

/// A synonym set analysed the way the index analyses its text: for each index token, the rules that expand it.
pub(crate) struct SynonymLookup {
    tokens: Vec<String>,
    rank_of: HashMap<String, u32>,
    rule_tokens: Vec<Vec<u32>>,
    token_rules: Vec<Vec<u32>>,
    cache: RwLock<HashMap<String, Arc<[String]>>>,
}

struct Analysis<'a> {
    analyser: &'a Analyser,
    analysed: HashMap<String, AnalysedWord>,
    strict: Option<&'a str>,
}

impl Analysis<'_> {
    fn analyse(&mut self, word: &str) -> Result<AnalysedWord> {
        if let Some(found) = self.analysed.get(word) {
            return Ok(found.clone());
        }
        let mut tokens: Vec<String> = Vec::new();
        self.analyser
            .visit_tokens(word, TokenOptions::INDEXING, &mut |term, _, _, _| {
                tokens.push(term.to_string())
            })?;
        let result = match tokens.len() {
            1 => AnalysedWord::Token(tokens.swap_remove(0)),
            count => AnalysedWord::Count(count),
        };
        self.analysed.insert(word.to_string(), result.clone());
        Ok(result)
    }

    fn token_of(&mut self, word: &str, rule: usize) -> Result<Option<String>> {
        match self.analyse(word)? {
            AnalysedWord::Token(token) => Ok(Some(token)),
            AnalysedWord::Count(count) => match self.strict {
                None => Ok(None),
                Some(source) => {
                    let reason = match count {
                        0 => "to no token, as a stop word does".to_string(),
                        count => format!("to {count} tokens, as a phrase does"),
                    };
                    Err(NarsilError::new(
                        ErrorCode::CONFIG_INVALID,
                        format!(
                            "{source}Synonym rule {rule} holds a word that the index analyses {reason}"
                        ),
                    ))
                }
            },
        }
    }
}

struct AnalysedRule {
    source: Option<String>,
    targets: Vec<String>,
}

fn analysed_rules(rules: &[SynonymRule], analysis: &mut Analysis<'_>) -> Result<Vec<AnalysedRule>> {
    let mut kept = Vec::new();
    for (rule, entry) in rules.iter().enumerate() {
        let (source, words) = match entry {
            SynonymRule::TwoWay(words) => (None, words),
            SynonymRule::OneWay { word, synonyms } => (Some(word), synonyms),
        };
        let source_token = match source {
            Some(word) => analysis.token_of(word, rule)?,
            None => None,
        };
        let mut targets: Vec<String> = Vec::new();
        for word in words {
            if let Some(token) = analysis.token_of(word, rule)?
                && !targets.contains(&token)
            {
                targets.push(token);
            }
        }
        match (source.is_some(), source_token) {
            (false, _) => kept.push(AnalysedRule {
                source: None,
                targets,
            }),
            (true, Some(token)) => kept.push(AnalysedRule {
                source: Some(token),
                targets,
            }),
            (true, None) => {}
        }
    }
    Ok(kept)
}

impl SynonymLookup {
    /// Builds the lookup of a checked synonym set, or returns `None` where no rule holds a word that analyses to
    /// one token. With `strict`, a word that analyses to no token or to several fails the set, with that prefix.
    pub(crate) fn build(
        rules: &[SynonymRule],
        analyser: &Analyser,
        strict: Option<&str>,
    ) -> Result<Option<SynonymLookup>> {
        let mut analysis = Analysis {
            analyser,
            analysed: HashMap::new(),
            strict,
        };
        let analysed = analysed_rules(rules, &mut analysis)?;
        if analysed.iter().all(|rule| rule.targets.is_empty()) {
            return Ok(None);
        }
        let distinct: BTreeSet<&str> = analysed
            .iter()
            .flat_map(|rule| rule.source.iter().chain(&rule.targets))
            .map(String::as_str)
            .collect();
        let tokens: Vec<String> = distinct.into_iter().map(str::to_string).collect();
        let rank_of: HashMap<String, u32> = tokens
            .iter()
            .enumerate()
            .map(|(rank, token)| (token.clone(), rank as u32))
            .collect();
        let rank = |token: &String| rank_of.get(token).copied().unwrap_or(0);
        let mut rule_tokens = Vec::with_capacity(analysed.len());
        let mut token_rules: Vec<Vec<u32>> = vec![Vec::new(); tokens.len()];
        for (at, rule) in analysed.iter().enumerate() {
            let members: Vec<u32> = rule.targets.iter().map(rank).collect();
            match &rule.source {
                Some(source) => token_rules[rank(source) as usize].push(at as u32),
                None => members
                    .iter()
                    .for_each(|&member| token_rules[member as usize].push(at as u32)),
            }
            rule_tokens.push(members);
        }
        Ok(Some(SynonymLookup {
            tokens,
            rank_of,
            rule_tokens,
            token_rules,
            cache: RwLock::new(HashMap::new()),
        }))
    }

    fn collect(&self, token: u32) -> Arc<[String]> {
        let mut found: Vec<u32> = Vec::new();
        for &rule in self.token_rules.get(token as usize).into_iter().flatten() {
            let members = self.rule_tokens.get(rule as usize).into_iter().flatten();
            found.extend(members.filter(|&&member| member != token));
        }
        found.sort_unstable();
        found.dedup();
        found
            .into_iter()
            .take(SYNONYMS_ADDED_PER_QUERY)
            .filter_map(|rank| self.tokens.get(rank as usize).cloned())
            .collect()
    }

    /// Returns the synonyms of an index token in code point order, at most 50.
    pub(crate) fn synonyms_of(&self, token: &str) -> Arc<[String]> {
        let cached = self
            .cache
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(token)
            .cloned();
        if let Some(found) = cached {
            return found;
        }
        let Some(&rank) = self.rank_of.get(token) else {
            return Arc::from(Vec::new());
        };
        let found = self.collect(rank);
        let mut held = self
            .cache
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if held.len() >= SYNONYM_EXPANSION_CACHE_ENTRIES {
            held.clear();
        }
        held.insert(token.to_string(), found.clone());
        found
    }

    /// Returns the synonyms that a query adds to each of its tokens, in query order: at most 50 in all, shared
    /// evenly between the tokens that hold synonyms, with the earlier tokens taking the remainder.
    pub(crate) fn expand(&self, query_tokens: &[String]) -> Vec<(String, Vec<String>)> {
        let mut with_synonyms: Vec<(&str, Arc<[String]>)> = Vec::new();
        let mut seen: HashSet<&str> = HashSet::new();
        for token in query_tokens {
            if !seen.insert(token) {
                continue;
            }
            let synonyms = self.synonyms_of(token);
            if !synonyms.is_empty() {
                with_synonyms.push((token, synonyms));
            }
            if with_synonyms.len() == SYNONYMS_ADDED_PER_QUERY {
                break;
            }
        }
        let count = with_synonyms.len();
        if count == 0 {
            return Vec::new();
        }
        let share = SYNONYMS_ADDED_PER_QUERY / count;
        let extra = SYNONYMS_ADDED_PER_QUERY % count;
        with_synonyms
            .into_iter()
            .enumerate()
            .map(|(order, (token, synonyms))| {
                let quota = share + usize::from(order < extra);
                (
                    token.to_string(),
                    synonyms.iter().take(quota).cloned().collect(),
                )
            })
            .collect()
    }
}

use std::collections::{BTreeSet, HashMap};

use super::selection::{SynonymSelection, SynonymTable, table_index};
use crate::analysis::{Analyser, TokenOptions};
use crate::config::SynonymRule;
use crate::error::{ErrorCode, NarsilError, Result};

const NO_SOURCE_TOKEN: i32 = -1;

#[derive(Clone)]
enum AnalysedWord {
    Token(String),
    Count(usize),
}

/// A synonym set analysed the way the index analyses its text, held as the table that the native core expands.
pub(crate) struct SynonymLookup {
    selection: SynonymSelection,
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

fn table_of(analysed: &[AnalysedRule]) -> Result<SynonymTable> {
    let distinct: BTreeSet<&str> = analysed
        .iter()
        .flat_map(|rule| rule.source.iter().chain(&rule.targets))
        .map(String::as_str)
        .collect();
    let mut table = SynonymTable::default();
    let mut rank_of: HashMap<&str, u32> = HashMap::with_capacity(distinct.len());
    table.offsets.push(0);
    for token in distinct {
        rank_of.insert(token, table_index(rank_of.len())?);
        table.tokens.extend_from_slice(token.as_bytes());
        table.offsets.push(table_index(table.tokens.len())?);
    }
    let rank = |token: &String| rank_of.get(token.as_str()).copied().unwrap_or(0);
    let mut opened: Vec<Vec<u32>> = vec![Vec::new(); rank_of.len()];
    table.rule_start.push(0);
    for (at, rule) in analysed.iter().enumerate() {
        let rule_index = table_index(at)?;
        let members: Vec<u32> = rule.targets.iter().map(rank).collect();
        match &rule.source {
            Some(source) => {
                table.rule_source.push(rank(source) as i32);
                opened[rank(source) as usize].push(rule_index);
            }
            None => {
                table.rule_source.push(NO_SOURCE_TOKEN);
                for &member in &members {
                    opened[member as usize].push(rule_index);
                }
            }
        }
        table.rule_tokens.extend(members);
        table.rule_start.push(table_index(table.rule_tokens.len())?);
    }
    table.token_start.push(0);
    for rules in opened {
        table.token_rules.extend(rules);
        table
            .token_start
            .push(table_index(table.token_rules.len())?);
    }
    Ok(table)
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
        Ok(Some(SynonymLookup {
            selection: SynonymSelection::new(table_of(&analysed)?),
        }))
    }

    /// Returns the synonyms that a query adds to each of its tokens, in query order: at most 50 in all, shared
    /// evenly between the tokens that hold synonyms, with the earlier tokens taking the remainder.
    pub(crate) fn expand(&self, query_tokens: &[String]) -> Result<Vec<(String, Vec<String>)>> {
        self.selection.select(query_tokens)
    }
}

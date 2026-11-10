use super::constants::{
    MAX_SYNONYM_RULE_WORDS, MAX_SYNONYM_RULES, MIN_ONE_WAY_SYNONYMS, MIN_TWO_WAY_SYNONYM_WORDS,
};
use super::rules::validate_synonym_rules;
use crate::config::SynonymRule;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::value::{Map, Value};

fn invalid(source: &str, message: String) -> NarsilError {
    NarsilError::new(ErrorCode::CONFIG_INVALID, format!("{source}{message}"))
}

fn holds_only(rule: &Map, keys: &[&str]) -> bool {
    rule.len() == keys.len() && keys.iter().all(|key| rule.contains_key(key))
}

fn word_of(value: Option<&Value>, rule: usize, source: &str) -> Result<String> {
    match value {
        Some(Value::String(word)) => Ok(word.clone()),
        _ => Err(invalid(
            source,
            format!("Synonym rule {rule} holds a word that is not a string"),
        )),
    }
}

fn words_of(
    value: Option<&Value>,
    rule: usize,
    key: &str,
    (minimum, maximum): (usize, usize),
    source: &str,
) -> Result<Vec<String>> {
    let Some(Value::Array(items)) = value.filter(|value| {
        value
            .as_array()
            .is_some_and(|items| (minimum..=maximum).contains(&items.len()))
    }) else {
        return Err(invalid(
            source,
            format!(
                "Synonym rule {rule} needs \"{key}\" as a list of {minimum} to {maximum} words"
            ),
        ));
    };
    items
        .iter()
        .map(|item| word_of(Some(item), rule, source))
        .collect()
}

fn rule_of(value: &Value, rule: usize, source: &str) -> Result<SynonymRule> {
    let Value::Object(entry) = value else {
        return Err(invalid(
            source,
            format!("Synonym rule {rule} must be an object"),
        ));
    };
    if holds_only(entry, &["words"]) {
        let bounds = (MIN_TWO_WAY_SYNONYM_WORDS, MAX_SYNONYM_RULE_WORDS);
        let words = words_of(entry.get("words"), rule, "words", bounds, source)?;
        return Ok(SynonymRule::TwoWay(words));
    }
    if holds_only(entry, &["word", "synonyms"]) {
        let word = word_of(entry.get("word"), rule, source)?;
        let bounds = (MIN_ONE_WAY_SYNONYMS, MAX_SYNONYM_RULE_WORDS - 1);
        let synonyms = words_of(entry.get("synonyms"), rule, "synonyms", bounds, source)?;
        return Ok(SynonymRule::OneWay { word, synonyms });
    }
    Err(invalid(
        source,
        format!(
            "Synonym rule {rule} must hold either \"words\" alone, or \"word\" and \"synonyms\""
        ),
    ))
}

/// Reads a stored synonym set, refusing a malformed one with `CONFIG_INVALID` and a message that opens with `source`.
pub(crate) fn synonym_rules_of(value: &Value, source: &str) -> Result<Vec<SynonymRule>> {
    let Value::Array(items) = value else {
        return Err(invalid(
            source,
            "A synonym set must be a list of rules".to_string(),
        ));
    };
    if items.len() > MAX_SYNONYM_RULES {
        return Err(invalid(
            source,
            format!("A synonym set holds at most {MAX_SYNONYM_RULES} rules"),
        ));
    }
    let rules = items
        .iter()
        .enumerate()
        .map(|(rule, item)| rule_of(item, rule, source))
        .collect::<Result<Vec<_>>>()?;
    validate_synonym_rules(&rules, source)?;
    Ok(rules)
}

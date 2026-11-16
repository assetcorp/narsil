use narsil::{Map, SynonymRule, Value};

use super::constants::{
    MAX_SYNONYM_RULE_WORDS, MAX_SYNONYM_RULES, MAX_SYNONYM_WORD_BYTES, MAX_SYNONYM_WORDS,
    MIN_ONE_WAY_SYNONYMS, MIN_TWO_WAY_SYNONYM_WORDS,
};
use crate::errors::{Outcome, ServerError};
use crate::handlers::common::object;

const FIRST_PRINTABLE_CODE: char = '\u{20}';

#[derive(Default)]
struct Tally {
    words: usize,
    bytes: usize,
}

fn rule_problem(rule: usize, message: String) -> ServerError {
    ServerError::config_invalid(message).with_detail("rule", Value::Number(rule as f64))
}

fn read_word(value: &Value, rule: usize, tally: &mut Tally) -> Outcome<String> {
    let Value::String(word) = value else {
        return Err(rule_problem(
            rule,
            format!("Synonym rule {rule} holds a word that is not a string"),
        ));
    };
    if word
        .chars()
        .any(|character| character < FIRST_PRINTABLE_CODE)
    {
        return Err(rule_problem(
            rule,
            format!("Synonym rule {rule} holds a word with a control character"),
        ));
    }
    tally.words = tally.words.saturating_add(1);
    tally.bytes = tally.bytes.saturating_add(word.len());
    if tally.words > MAX_SYNONYM_WORDS {
        return Err(ServerError::config_invalid(format!(
            "A synonym set holds at most {MAX_SYNONYM_WORDS} words"
        ))
        .with_detail("maxWords", Value::Number(MAX_SYNONYM_WORDS as f64)));
    }
    if tally.bytes > MAX_SYNONYM_WORD_BYTES {
        return Err(ServerError::config_invalid(format!(
            "The words of a synonym set hold at most {MAX_SYNONYM_WORD_BYTES} bytes in UTF-8"
        ))
        .with_detail("maxWordBytes", Value::Number(MAX_SYNONYM_WORD_BYTES as f64)));
    }
    Ok(word.clone())
}

struct WordList<'a> {
    key: &'a str,
    minimum: usize,
    maximum: usize,
}

fn read_words(
    value: Option<&Value>,
    rule: usize,
    list: WordList<'_>,
    tally: &mut Tally,
) -> Outcome<Vec<String>> {
    let items = match value {
        Some(Value::Array(items)) if (list.minimum..=list.maximum).contains(&items.len()) => items,
        _ => {
            return Err(rule_problem(
                rule,
                format!(
                    "Synonym rule {rule} needs \"{}\" as a list of {} to {} words",
                    list.key, list.minimum, list.maximum
                ),
            ));
        }
    };
    items
        .iter()
        .map(|item| read_word(item, rule, tally))
        .collect()
}

fn has_only_keys(fields: &Map, keys: &[&str]) -> bool {
    fields.len() == keys.len() && keys.iter().all(|key| fields.contains_key(key))
}

fn read_rule(value: &Value, rule: usize, tally: &mut Tally) -> Outcome<SynonymRule> {
    let Value::Object(fields) = value else {
        return Err(rule_problem(
            rule,
            format!("Synonym rule {rule} must be an object"),
        ));
    };
    if has_only_keys(fields, &["words"]) {
        let list = WordList {
            key: "words",
            minimum: MIN_TWO_WAY_SYNONYM_WORDS,
            maximum: MAX_SYNONYM_RULE_WORDS,
        };
        return Ok(SynonymRule::TwoWay(read_words(
            fields.get("words"),
            rule,
            list,
            tally,
        )?));
    }
    if has_only_keys(fields, &["word", "synonyms"]) {
        let word = read_word(fields.get("word").unwrap_or(&Value::Null), rule, tally)?;
        let list = WordList {
            key: "synonyms",
            minimum: MIN_ONE_WAY_SYNONYMS,
            maximum: MAX_SYNONYM_RULE_WORDS - 1,
        };
        let synonyms = read_words(fields.get("synonyms"), rule, list, tally)?;
        return Ok(SynonymRule::OneWay { word, synonyms });
    }
    Err(rule_problem(
        rule,
        format!(
            "Synonym rule {rule} must hold either \"words\" alone, or \"word\" and \"synonyms\""
        ),
    ))
}

pub(crate) fn synonym_rules_of(value: &Value) -> Outcome<Vec<SynonymRule>> {
    let Value::Array(rules) = value else {
        return Err(ServerError::config_invalid(
            "A synonym set must be a list of rules",
        ));
    };
    if rules.len() > MAX_SYNONYM_RULES {
        return Err(ServerError::config_invalid(format!(
            "A synonym set holds at most {MAX_SYNONYM_RULES} rules"
        ))
        .with_detail("maxRules", Value::Number(MAX_SYNONYM_RULES as f64)));
    }
    let mut tally = Tally::default();
    rules
        .iter()
        .enumerate()
        .map(|(rule, value)| read_rule(value, rule, &mut tally))
        .collect()
}

fn words_json(words: &[String]) -> Value {
    Value::Array(words.iter().cloned().map(Value::String).collect())
}

pub(crate) fn synonym_set_json(rules: &[SynonymRule]) -> Value {
    let listed = rules
        .iter()
        .map(|rule| match rule {
            SynonymRule::TwoWay(words) => object(vec![("words", words_json(words))]),
            SynonymRule::OneWay { word, synonyms } => object(vec![
                ("word", Value::String(word.clone())),
                ("synonyms", words_json(synonyms)),
            ]),
        })
        .collect();
    object(vec![("synonyms", Value::Array(listed))])
}

use super::constants::{
    MAX_SYNONYM_RULE_WORDS, MAX_SYNONYM_RULES, MAX_SYNONYM_WORD_BYTES, MAX_SYNONYM_WORDS,
    MIN_ONE_WAY_SYNONYMS, MIN_TWO_WAY_SYNONYM_WORDS,
};
use crate::config::SynonymRule;
use crate::error::{ErrorCode, NarsilError, Result};

const FIRST_PRINTABLE_CODE: char = '\u{20}';

#[derive(Default)]
struct Tally {
    words: usize,
    bytes: usize,
}

fn invalid(source: &str, message: String) -> NarsilError {
    NarsilError::new(ErrorCode::CONFIG_INVALID, format!("{source}{message}"))
}

fn check_word(word: &str, rule: usize, tally: &mut Tally, source: &str) -> Result<()> {
    if word
        .chars()
        .any(|character| character < FIRST_PRINTABLE_CODE)
    {
        return Err(invalid(
            source,
            format!("Synonym rule {rule} holds a word with a control character"),
        ));
    }
    tally.words += 1;
    tally.bytes += word.len();
    if tally.words > MAX_SYNONYM_WORDS {
        return Err(invalid(
            source,
            format!("A synonym set holds at most {MAX_SYNONYM_WORDS} words"),
        ));
    }
    if tally.bytes > MAX_SYNONYM_WORD_BYTES {
        return Err(invalid(
            source,
            format!(
                "The words of a synonym set hold at most {MAX_SYNONYM_WORD_BYTES} bytes in UTF-8"
            ),
        ));
    }
    Ok(())
}

fn check_words(
    words: &[String],
    rule: usize,
    key: &str,
    (minimum, maximum): (usize, usize),
    tally: &mut Tally,
    source: &str,
) -> Result<()> {
    if words.len() < minimum || words.len() > maximum {
        return Err(invalid(
            source,
            format!(
                "Synonym rule {rule} needs \"{key}\" as a list of {minimum} to {maximum} words"
            ),
        ));
    }
    words
        .iter()
        .try_for_each(|word| check_word(word, rule, tally, source))
}

/// Checks a synonym set against the limits that every Narsil engine applies, prefixing each message with `source`.
pub(crate) fn validate_synonym_rules(rules: &[SynonymRule], source: &str) -> Result<()> {
    if rules.len() > MAX_SYNONYM_RULES {
        return Err(invalid(
            source,
            format!("A synonym set holds at most {MAX_SYNONYM_RULES} rules"),
        ));
    }
    let mut tally = Tally::default();
    for (rule, entry) in rules.iter().enumerate() {
        match entry {
            SynonymRule::TwoWay(words) => check_words(
                words,
                rule,
                "words",
                (MIN_TWO_WAY_SYNONYM_WORDS, MAX_SYNONYM_RULE_WORDS),
                &mut tally,
                source,
            )?,
            SynonymRule::OneWay { word, synonyms } => {
                check_word(word, rule, &mut tally, source)?;
                check_words(
                    synonyms,
                    rule,
                    "synonyms",
                    (MIN_ONE_WAY_SYNONYMS, MAX_SYNONYM_RULE_WORDS - 1),
                    &mut tally,
                    source,
                )?;
            }
        }
    }
    Ok(())
}

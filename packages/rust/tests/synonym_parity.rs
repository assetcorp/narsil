mod support;

use narsil::{IndexConfig, Map, Value, parse_json};
use support::parity::{
    ParitySpec, conformance_searches, crate_outcomes, dataset_documents, reference_outcomes,
    synonym_rules,
};
use support::parity_cases::{
    answered_count, chosen_writes, index_config, query, require_same_outcomes,
};

const INDEX_NAME: &str = "bills";

fn json(text: &str) -> Value {
    parse_json(text).expect("the value is JSON")
}

fn synonym_queries() -> Vec<Value> {
    vec![
        query(r#"{"term": "levy"}"#),
        query(r#"{"term": "tax"}"#),
        query(r#"{"term": "taxes credits", "limit": 25}"#),
        query(r#"{"term": "school"}"#),
        query(r#"{"term": "education"}"#),
        query(r#"{"term": "power grid", "termMatch": "all"}"#),
        query(r#"{"term": "energy power"}"#),
        query(r#"{"term": "levy", "exact": true}"#),
        query(r#"{"term": "levi", "tolerance": 1}"#),
        query(r#"{"term": "tax", "tolerance": 1}"#),
        query(r#"{"term": "lev", "prefix": true}"#),
        query(r#"{"term": "school lev", "prefix": true, "termMatch": 2}"#),
        query(r#"{"term": "\"internal revenue\" levy"}"#),
        query(r#"{"term": "medical", "fields": ["title"]}"#),
        query(r#"{"term": "healthcare levy duty", "minScore": 4}"#),
    ]
}

fn config_with_synonyms(rules: &Value) -> Map {
    let mut config = Map::new();
    config.insert("synonyms", rules.clone());
    config
}

#[test]
fn queries_over_a_configured_synonym_set_answer_exactly_as_the_reference_does() {
    let searches = conformance_searches();
    let (removals, updates) = chosen_writes();
    let rules = json(
        r#"[
            {"words": ["tax", "levy", "duty"]},
            {"word": "school", "synonyms": ["education", "academy", "schools"]},
            {"words": ["energy", "power"]},
            {"words": ["health", "medical", "healthcare"]},
            {"words": ["Taxes", "levies"]}
        ]"#,
    );
    let spec = ParitySpec {
        index: INDEX_NAME.to_string(),
        config: config_with_synonyms(&rules),
        removals,
        updates,
        synonym_updates: Vec::new(),
        queries: synonym_queries(),
    };
    let wanted = reference_outcomes(&spec);
    assert!(
        answered_count(&wanted) >= 12,
        "the reference answers too few queries"
    );
    let crate_config = IndexConfig {
        synonyms: Some(synonym_rules(&rules)),
        ..index_config(&searches)
    };
    let found = crate_outcomes(&spec, crate_config);
    require_same_outcomes(&spec, &found, &wanted);
}

const SUMMARY_WORD_LENGTHS: std::ops::RangeInclusive<usize> = 6..=12;
const WIDE_RULE_WORDS: usize = 40;
const WIDE_RULE_COUNT: usize = 3;
const PAIR_RULE_COUNT: usize = 60;

fn summary_words() -> Vec<String> {
    let mut words = std::collections::BTreeSet::new();
    for document in dataset_documents() {
        let summary = document
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or("");
        for word in summary.split(|character: char| !character.is_ascii_alphabetic()) {
            if SUMMARY_WORD_LENGTHS.contains(&word.len()) {
                words.insert(word.to_ascii_lowercase());
            }
        }
    }
    words.into_iter().collect()
}

fn quoted(words: &[String]) -> String {
    words
        .iter()
        .map(|word| format!("\"{word}\""))
        .collect::<Vec<_>>()
        .join(",")
}

#[test]
fn queries_whose_tokens_hold_more_than_fifty_synonyms_share_them_as_the_reference_does() {
    let searches = conformance_searches();
    let (removals, updates) = chosen_writes();
    let words = summary_words();
    let wide_words = WIDE_RULE_WORDS * WIDE_RULE_COUNT;
    assert!(
        words.len() >= wide_words + PAIR_RULE_COUNT * 2,
        "the dataset holds too few summary words"
    );
    let wide_rules: Vec<&[String]> = words[..wide_words].chunks(WIDE_RULE_WORDS).collect();
    let pair_rules: Vec<&[String]> = words[wide_words..wide_words + PAIR_RULE_COUNT * 2]
        .chunks(2)
        .collect();
    let rules_text: Vec<String> = wide_rules
        .iter()
        .chain(&pair_rules)
        .map(|rule| format!(r#"{{"words": [{}]}}"#, quoted(rule)))
        .collect();
    let rules = json(&format!("[{}]", rules_text.join(",")));
    let first_words = |rules: &[&[String]]| -> String {
        rules
            .iter()
            .map(|rule| rule[0].as_str())
            .collect::<Vec<_>>()
            .join(" ")
    };
    let wide_term = first_words(&wide_rules);
    let pair_term = first_words(&pair_rules);
    let queries = vec![
        query(&format!(r#"{{"term": "{wide_term}", "limit": 25}}"#)),
        query(&format!(
            r#"{{"term": "{}", "limit": 25}}"#,
            wide_rules[0][0]
        )),
        query(&format!(r#"{{"term": "{pair_term}", "limit": 25}}"#)),
        query(&format!(
            r#"{{"term": "{wide_term} {pair_term}", "limit": 25}}"#
        )),
    ];
    let spec = ParitySpec {
        index: INDEX_NAME.to_string(),
        config: config_with_synonyms(&rules),
        removals,
        updates,
        synonym_updates: Vec::new(),
        queries,
    };
    let wanted = reference_outcomes(&spec);
    assert_eq!(
        answered_count(&wanted),
        spec.queries.len(),
        "the reference answers every query"
    );
    let crate_config = IndexConfig {
        synonyms: Some(synonym_rules(&rules)),
        ..index_config(&searches)
    };
    let found = crate_outcomes(&spec, crate_config);
    require_same_outcomes(&spec, &found, &wanted);
}

#[test]
fn synonym_updates_refuse_the_sets_the_reference_refuses_and_apply_the_rest() {
    let searches = conformance_searches();
    let (removals, updates) = chosen_writes();
    let many_words: Vec<String> = (0..101).map(|at| format!("\"word{at}\"")).collect();
    let synonym_updates = vec![
        json(r#"[{"words": ["tax", "the"]}]"#),
        json(r#"[{"words": ["tax", "health care"]}]"#),
        json(r#"[{"words": ["tax"]}]"#),
        json(r#"[{"word": "tax", "synonyms": []}]"#),
        json(r#"[{"words": ["tax", "le\u0001vy"]}]"#),
        json(&format!(r#"[{{"words": [{}]}}]"#, many_words.join(","))),
        json(r#"[{"words": ["energy", "power"]}, {"word": "of", "synonyms": ["tax"]}]"#),
        json(r#"[{"words": ["energy", "power"]}, {"word": "school", "synonyms": ["education"]}]"#),
        json(
            r#"[{"words": ["tax", "levy", "duty"]}, {"word": "school", "synonyms": ["academy"]}]"#,
        ),
    ];
    let spec = ParitySpec {
        index: INDEX_NAME.to_string(),
        config: Map::new(),
        removals,
        updates,
        synonym_updates,
        queries: synonym_queries(),
    };
    let wanted = reference_outcomes(&spec);
    let found = crate_outcomes(&spec, index_config(&searches));
    require_same_outcomes(&spec, &found, &wanted);
}

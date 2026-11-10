mod support;

use std::collections::HashSet;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use narsil::{
    IndexConfig, Map, Narsil, StopWords, StopWordsSetting, Token, Tokenizer, TokenizerSetting,
    Value, parse_json, write_json,
};
use support::shaping_json::{page_value, shaping_params};
use support::{ScratchDirectory, repository_root};

const INDEX: &str = "kitchen";
const SCHEMA: &str = r#"{"title": "string", "body": "string:partial"}"#;
const REPLACED_STOP_WORDS: [&str; 4] = ["encounter", "the", "and", "mountain"];

struct SpaceSeparatedWords;

impl Tokenizer for SpaceSeparatedWords {
    fn tokenize(&self, text: &str) -> Vec<Token> {
        text.to_lowercase()
            .split(' ')
            .filter(|word| !word.is_empty())
            .zip(0u32..)
            .map(|(token, position)| Token {
                token: token.to_string(),
                position,
            })
            .collect()
    }
}

#[derive(Clone, Copy)]
enum Analysis {
    LanguageDefaults,
    ReplacedStopWords,
    SpaceSeparatedWords,
}

fn json(text: &str) -> Value {
    parse_json(text).expect("the value is JSON")
}

fn documents() -> Vec<Map> {
    json(
        r#"[
            {"id": "a", "title": "Kitchen counter", "body": "Countertop counterweight encounter accounts"},
            {"id": "b", "title": "Count of nothing", "body": "The mountain fountain recount and the counting house"},
            {"id": "c", "title": "Plain", "body": "Encountered rare accountants and counters in the mountain"},
            {"id": "d", "title": "Recounted", "body": "Unaccountable discount counted twice"},
            {"id": "e", "title": "Hyphens", "body": "the re-count of mountain-tops, counter-claims and ACCOUNT-holders"}
        ]"#,
    )
    .as_array()
    .expect("a list of documents")
    .iter()
    .map(|document| document.as_object().cloned().expect("an object"))
    .collect()
}

fn queries() -> Vec<Value> {
    [
        r#"{"term": "count", "partialWords": true, "highlight": {"fields": ["body", "title"]}}"#,
        r#"{"term": "unter", "partialWords": true, "highlight": {"fields": ["body"]}}"#,
        r#"{"term": "ount", "partialWords": true, "highlight": {"fields": ["body"], "maxSnippetLength": 12}}"#,
        r#"{"term": "mountain count", "partialWords": true, "highlight": {"fields": ["body"]}}"#,
        r#"{"term": "counter", "partialWords": true, "prefix": true, "highlight": {"fields": ["body"]}}"#,
        r#"{"term": "count", "highlight": {"fields": ["body", "title"]}}"#,
        r#"{"term": "count", "partialWords": true, "fields": ["title"], "highlight": {"fields": ["body", "title"]}}"#,
    ]
    .into_iter()
    .map(json)
    .collect()
}

fn reference_config(analysis: Analysis) -> Value {
    let mut config = Map::new();
    config.insert("schema", json(SCHEMA));
    config.insert("language", Value::String("english".into()));
    match analysis {
        Analysis::LanguageDefaults => {}
        Analysis::ReplacedStopWords => {
            config.insert(
                "stopWords",
                Value::Array(
                    REPLACED_STOP_WORDS
                        .iter()
                        .map(|word| Value::String(word.to_string()))
                        .collect(),
                ),
            );
        }
        Analysis::SpaceSeparatedWords => {
            config.insert("tokenizer", Value::String("spaceSeparatedWords".into()));
        }
    }
    Value::Object(config)
}

fn crate_config(analysis: Analysis) -> IndexConfig {
    let mut config = IndexConfig {
        schema: json(SCHEMA),
        language: Some("english".into()),
        ..IndexConfig::default()
    };
    match analysis {
        Analysis::LanguageDefaults => {}
        Analysis::ReplacedStopWords => {
            let words: HashSet<String> = REPLACED_STOP_WORDS
                .iter()
                .map(|word| word.to_string())
                .collect();
            config.stop_words = Some(StopWordsSetting::Words(StopWords::Set(words)));
        }
        Analysis::SpaceSeparatedWords => {
            config.tokenizer = Some(TokenizerSetting::Instance(Arc::new(SpaceSeparatedWords)));
        }
    }
    config
}

fn reference_pages(analysis: Analysis) -> Vec<Value> {
    let scratch = ScratchDirectory::new("highlights");
    let mut spec = Map::new();
    spec.insert("index", Value::String(INDEX.into()));
    spec.insert("config", reference_config(analysis));
    spec.insert(
        "documents",
        Value::Array(documents().into_iter().map(Value::Object).collect()),
    );
    spec.insert("queries", Value::Array(queries()));
    let spec_path = scratch.path().join("spec.json");
    std::fs::write(&spec_path, write_json(&Value::Object(spec))).expect("the spec is written");
    let script =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/reference_highlights.mjs");
    let output = Command::new("node")
        .arg(script)
        .arg(repository_root())
        .arg(&spec_path)
        .output()
        .expect("node runs the TypeScript reference");
    assert!(
        output.status.success(),
        "the TypeScript reference failed; build packages/ts first: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout).expect("the reference writes UTF-8");
    json(&text)
        .as_array()
        .cloned()
        .expect("the reference lists one page per query")
}

fn highlighted_hits(page: &Value) -> Value {
    let hits = page
        .pointer("hits")
        .and_then(Value::as_array)
        .expect("the page lists its hits")
        .iter()
        .map(|hit| {
            let mut kept = Map::new();
            for key in ["id", "highlights"] {
                kept.insert(key, hit.pointer(key).cloned().unwrap_or(Value::Null));
            }
            Value::Object(kept)
        })
        .collect();
    let mut kept = Map::new();
    kept.insert("hits", Value::Array(hits));
    Value::Object(kept)
}

fn crate_pages(analysis: Analysis) -> Vec<Value> {
    let engine = Narsil::new();
    engine
        .create_index(INDEX, crate_config(analysis))
        .expect("the index is created");
    let inserted = engine
        .insert_batch(INDEX, documents())
        .expect("the batch is inserted");
    assert!(
        inserted.failed.is_empty(),
        "the crate refused {:?}",
        inserted.failed
    );
    queries()
        .iter()
        .map(|query| match engine.query(INDEX, &shaping_params(query)) {
            Ok(result) => highlighted_hits(&page_value(&result)),
            Err(error) => json(&format!(r#"{{"error": {{"code": "{}"}}}}"#, error.code())),
        })
        .collect()
}

fn marked_spans(pages: &[Value]) -> usize {
    pages
        .iter()
        .filter_map(|page| page.pointer("hits").and_then(Value::as_array))
        .flatten()
        .filter_map(|hit| hit.pointer("highlights").and_then(Value::as_object))
        .flat_map(|highlights| highlights.values())
        .filter_map(|highlight| highlight.pointer("positions").and_then(Value::as_array))
        .map(Vec::len)
        .sum()
}

fn require_reference_highlights(analysis: Analysis) {
    let wanted = reference_pages(analysis);
    assert!(
        marked_spans(&wanted) > 0,
        "the reference marks no span, so the queries test nothing"
    );
    let found = crate_pages(analysis);
    assert_eq!(found.len(), wanted.len(), "one page per query");
    for ((query, found), wanted) in queries().iter().zip(&found).zip(&wanted) {
        assert_eq!(
            write_json(found),
            write_json(wanted),
            "the highlights differ for {}",
            write_json(query)
        );
    }
}

#[test]
fn partial_words_under_the_language_analysis_highlight_as_the_reference_does() {
    require_reference_highlights(Analysis::LanguageDefaults);
}

#[test]
fn partial_words_under_replaced_stop_words_highlight_as_the_reference_does() {
    require_reference_highlights(Analysis::ReplacedStopWords);
}

#[test]
fn partial_words_under_a_custom_tokenizer_highlight_as_the_reference_does() {
    require_reference_highlights(Analysis::SpaceSeparatedWords);
}

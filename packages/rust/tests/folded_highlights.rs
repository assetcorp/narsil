mod support;

use narsil::{IndexConfig, Map, Narsil, QueryParams, StopWords, StopWordsSetting, Value};
use support::folding::{
    edit_distance, highlight_spans, shares_leading_points, term_query, text_index, word_spans,
    yoruba_fold,
};

const BODY: &str = "ọkọ̀ kékeré ilé ọ̀rẹ́ ìwé";
const NAME: &str = "ayọkẹlẹ ọkọ̀ ìwé";
const SCHEMA: &str = r#"{"body": "string", "name": "string:partial"}"#;
const PARTIAL_QUERY: &str = "oke";

fn document(id: &str, body: &str, name: &str) -> Map {
    let mut map = Map::new();
    map.insert("id", Value::String(id.to_string()));
    map.insert("body", Value::String(body.to_string()));
    map.insert("name", Value::String(name.to_string()));
    map
}

fn engine_with(config: IndexConfig) -> Narsil {
    let narsil = Narsil::new();
    narsil
        .create_index("words", config)
        .expect("the index is created");
    let written = narsil
        .insert_batch(
            "words",
            vec![
                document("marked", BODY, NAME),
                document("other", "eja oja", "agba"),
            ],
        )
        .expect("the batch is written");
    assert!(written.failed.is_empty(), "the batch refused documents");
    narsil
}

fn spans(narsil: &Narsil, params: QueryParams, field: &str) -> Option<Vec<(usize, usize)>> {
    highlight_spans(narsil, "words", params, "marked", field)
}

fn partial_name_spans() -> Vec<(usize, usize)> {
    word_spans(NAME, |word| {
        let fold = yoruba_fold(word);
        fold.chars().count() > PARTIAL_QUERY.len() && fold.contains(PARTIAL_QUERY)
    })
}

#[test]
fn a_highlight_marks_each_marked_word_that_a_query_without_marks_finds() {
    let narsil = engine_with(text_index("yoruba", SCHEMA));

    let queried = ["oko", "ile", "ore"];
    let expected = word_spans(BODY, |word| queried.contains(&yoruba_fold(word).as_str()));
    assert_eq!(expected.len(), 3);
    assert_eq!(
        spans(&narsil, term_query("oko ile ore"), "body"),
        Some(expected)
    );

    let typo = "kekera";
    let expected = word_spans(BODY, |word| {
        let fold = yoruba_fold(word);
        shares_leading_points(&fold, typo, 2) && edit_distance(&fold, typo) <= 1
    });
    assert_eq!(expected.len(), 1);
    let params = QueryParams {
        tolerance: Some(1),
        ..term_query(typo)
    };
    assert_eq!(spans(&narsil, params, "body"), Some(expected));

    let expected = word_spans(BODY, |word| yoruba_fold(word).starts_with("ke"));
    let params = QueryParams {
        prefix: Some(true),
        ..term_query("ke")
    };
    assert_eq!(spans(&narsil, params, "body"), Some(expected));

    let phrase = ["kekere", "ile"];
    let expected = word_spans(BODY, |word| phrase.contains(&yoruba_fold(word).as_str()));
    assert_eq!(
        spans(&narsil, term_query("\"kekere ile\""), "body"),
        Some(expected)
    );

    let expected = partial_name_spans();
    assert_eq!(expected.len(), 1);
    let params = QueryParams {
        partial_words: Some(true),
        ..term_query(PARTIAL_QUERY)
    };
    assert_eq!(spans(&narsil, params, "name"), Some(expected));
}

#[test]
fn an_exact_query_marks_only_the_written_spelling() {
    let narsil = engine_with(text_index("yoruba", SCHEMA));
    let params = QueryParams {
        exact: Some(true),
        ..term_query("oko")
    };
    let result = narsil.query("words", &params).expect("the search answers");
    assert!(result.hits.is_empty(), "an exact query matched a fold");
    let params = QueryParams {
        exact: Some(true),
        ..term_query("ọkọ̀")
    };
    assert_eq!(
        spans(&narsil, params, "body"),
        Some(word_spans(BODY, |word| word == "ọkọ̀"))
    );
}

#[test]
fn an_index_with_its_own_stop_words_marks_a_folded_partial_word() {
    let narsil = engine_with(IndexConfig {
        stop_words: Some(StopWordsSetting::Words(StopWords::Set(
            ["ati".to_string()].into_iter().collect(),
        ))),
        ..text_index("yoruba", SCHEMA)
    });
    let params = QueryParams {
        partial_words: Some(true),
        ..term_query(PARTIAL_QUERY)
    };
    assert_eq!(spans(&narsil, params, "name"), Some(partial_name_spans()));
    let params = QueryParams {
        partial_words: Some(true),
        ..term_query("oko ile")
    };
    let expected = word_spans(NAME, |word| yoruba_fold(word) == "oko");
    assert_eq!(spans(&narsil, params, "name"), Some(expected));
}

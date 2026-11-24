mod support;

use narsil::{IndexConfig, Narsil, PartitionConfig, QueryParams, TermMatch};
use support::folding::{
    HAUSA_HOOKED_LETTERS, WordDocument, YORUBA_QUERY_WORDS, YORUBA_WORDS, edit_distance,
    fold_oracle, generated_documents, hit_ids, ids_with_word, insert_all, ranked_ids,
    shares_leading_points, term_query, text_index, yoruba_fold,
};

const CORPUS_SIZE: usize = 240;
const CORPUS_SEED: u64 = 7;
const PARTITIONS: usize = 3;
const DEFAULT_FUZZY_PREFIX_LENGTH: usize = 2;
const BODY: &str = r#"{"body": "string"}"#;

fn words(pairs: &[(&str, &str)]) -> Vec<WordDocument> {
    pairs
        .iter()
        .map(|(id, body)| WordDocument {
            id: id.to_string(),
            body: body.to_string(),
        })
        .collect()
}

fn folded_engine(documents: &[WordDocument]) -> Narsil {
    let narsil = Narsil::new();
    narsil
        .create_index(
            "yoruba",
            IndexConfig {
                partitions: Some(PartitionConfig {
                    max_partitions: Some(PARTITIONS as u64),
                    ..PartitionConfig::default()
                }),
                ..text_index("yoruba", BODY)
            },
        )
        .expect("the folding index is created");
    insert_all(&narsil, "yoruba", documents);
    narsil
        .rebalance("yoruba", PARTITIONS)
        .expect("the index spreads over three partitions");
    narsil
        .create_index(
            "plain",
            IndexConfig {
                fold_marks: Some(false),
                ..text_index("yoruba", BODY)
            },
        )
        .expect("the index without folding is created");
    insert_all(&narsil, "plain", documents);
    narsil
}

#[test]
fn a_query_without_marks_finds_every_folded_spelling() {
    let documents = generated_documents(CORPUS_SIZE, &YORUBA_WORDS, CORPUS_SEED);
    let narsil = folded_engine(&documents);

    for query in YORUBA_QUERY_WORDS {
        let expected = ids_with_word(&documents, |word| yoruba_fold(word) == query);
        assert!(!expected.is_empty(), "the corpus holds {query}");
        assert_eq!(
            hit_ids(&narsil, "yoruba", &term_query(query)),
            expected,
            "{query}"
        );
    }

    for marked in ["ọkọ̀", "ìlú", "ṣẹ́gun", "ọ̀rẹ́"] {
        let expected = ids_with_word(&documents, |word| yoruba_fold(word) == yoruba_fold(marked));
        assert_eq!(
            hit_ids(&narsil, "yoruba", &term_query(marked)),
            expected,
            "{marked}"
        );
    }

    for query in ["oko", "ọkọ", "ile"] {
        let expected = ids_with_word(&documents, |word| word == query);
        let exact = QueryParams {
            exact: Some(true),
            ..term_query(query)
        };
        assert_eq!(
            hit_ids(&narsil, "yoruba", &exact),
            expected,
            "exact {query}"
        );
    }

    for query in YORUBA_QUERY_WORDS {
        let expected = ids_with_word(&documents, |word| word == query);
        assert_eq!(
            hit_ids(&narsil, "plain", &term_query(query)),
            expected,
            "unfolded {query}"
        );
    }
}

#[test]
fn a_typo_and_a_half_typed_word_reach_marked_spellings() {
    let documents = generated_documents(CORPUS_SIZE, &YORUBA_WORDS, CORPUS_SEED);
    let narsil = folded_engine(&documents);

    for word in YORUBA_QUERY_WORDS {
        let query = format!("{}x", &word[..word.len() - 1]);
        let accepts = |candidate: &str| {
            shares_leading_points(candidate, &query, DEFAULT_FUZZY_PREFIX_LENGTH)
                && edit_distance(candidate, &query) <= 1
        };
        let expected = ids_with_word(&documents, |candidate| {
            accepts(candidate) || accepts(&yoruba_fold(candidate))
        });
        assert!(!expected.is_empty(), "the corpus holds a typo of {query}");
        let typo = QueryParams {
            tolerance: Some(1),
            ..term_query(&query)
        };
        assert_eq!(hit_ids(&narsil, "yoruba", &typo), expected, "{query}");
    }

    for word in YORUBA_QUERY_WORDS {
        let typed: String = word.chars().take(2).collect();
        let expected = ids_with_word(&documents, |candidate| {
            candidate.starts_with(&typed) || yoruba_fold(candidate).starts_with(&typed)
        });
        let prefix = QueryParams {
            prefix: Some(true),
            ..term_query(&typed)
        };
        assert_eq!(hit_ids(&narsil, "yoruba", &prefix), expected, "{typed}");
    }
}

#[test]
fn every_query_word_covers_its_term_through_a_marked_spelling() {
    let documents = generated_documents(CORPUS_SIZE, &YORUBA_WORDS, CORPUS_SEED);
    let narsil = folded_engine(&documents);
    for (first, second) in [("oko", "ile"), ("eja", "iwe"), ("omo", "kekere")] {
        let holds = |document: &WordDocument, query: &str| {
            document
                .body
                .split(' ')
                .any(|word| yoruba_fold(word) == query)
        };
        let mut expected: Vec<String> = documents
            .iter()
            .filter(|document| holds(document, first) && holds(document, second))
            .map(|document| document.id.clone())
            .collect();
        expected.sort();
        let every = QueryParams {
            term_match: Some(TermMatch::All),
            ..term_query(&format!("{first} {second}"))
        };
        assert_eq!(
            hit_ids(&narsil, "yoruba", &every),
            expected,
            "{first} {second}"
        );
    }
}

#[test]
fn the_written_spelling_ranks_above_a_marked_spelling() {
    let narsil = Narsil::new();
    narsil
        .create_index("ranking", text_index("yoruba", BODY))
        .expect("the index is created");
    insert_all(
        &narsil,
        "ranking",
        &words(&[("marked", "ọkọ kekere"), ("plain", "oko kekere")]),
    );
    assert_eq!(
        ranked_ids(&narsil, "ranking", &term_query("oko")),
        ["plain", "marked"]
    );
    assert_eq!(
        ranked_ids(&narsil, "ranking", &term_query("ọkọ")),
        ["marked", "plain"]
    );
}

#[test]
fn a_quoted_phrase_matches_the_marked_words_of_a_document() {
    let narsil = Narsil::new();
    narsil
        .create_index("phrases", text_index("yoruba", BODY))
        .expect("the index is created");
    insert_all(
        &narsil,
        "phrases",
        &words(&[
            ("marked", "ọkọ̀ kékeré"),
            ("plain", "oko kekere"),
            ("reversed", "kékeré ọkọ̀"),
        ]),
    );
    assert_eq!(
        hit_ids(&narsil, "phrases", &term_query("\"oko kekere\"")),
        ["marked", "plain"]
    );
    let exact = QueryParams {
        exact: Some(true),
        ..term_query("\"oko kekere\"")
    };
    assert_eq!(hit_ids(&narsil, "phrases", &exact), ["plain"]);
}

#[test]
fn hausa_folds_its_hooked_letters_and_french_folds_before_it_stems() {
    let narsil = Narsil::new();
    let hausa = words(&[
        ("hooked-room", "ɗaki"),
        ("plain-room", "daki"),
        ("hooked-door", "ƙofa"),
        ("plain-door", "kofa"),
        ("hooked-rat", "ɓera"),
        ("plain-rat", "bera"),
    ]);
    narsil
        .create_index("hausa", text_index("hausa", BODY))
        .expect("the Hausa index is created");
    insert_all(&narsil, "hausa", &hausa);
    for query in ["daki", "kofa", "bera"] {
        let expected = ids_with_word(&hausa, |word| {
            fold_oracle(word, &HAUSA_HOOKED_LETTERS) == query
        });
        assert_eq!(
            hit_ids(&narsil, "hausa", &term_query(query)),
            expected,
            "{query}"
        );
    }

    narsil
        .create_index("french", text_index("french", BODY))
        .expect("the French index is created");
    insert_all(
        &narsil,
        "french",
        &words(&[("marked", "après la pluie"), ("plain", "apres midi")]),
    );
    assert_eq!(
        ranked_ids(&narsil, "french", &term_query("apres")),
        ["plain", "marked"]
    );
    assert_eq!(
        ranked_ids(&narsil, "french", &term_query("après")),
        ["marked", "plain"]
    );
}

#[test]
fn an_english_index_scores_as_an_index_without_folding() {
    let narsil = Narsil::new();
    let english = words(&[
        ("accented", "café latte naïve résumé"),
        ("plain", "cafe mocha naive resume"),
        ("other", "coffee and tea"),
    ]);
    narsil
        .create_index("default", text_index("english", BODY))
        .expect("the default index is created");
    narsil
        .create_index(
            "unfolded",
            IndexConfig {
                fold_marks: Some(false),
                ..text_index("english", BODY)
            },
        )
        .expect("the unfolded index is created");
    insert_all(&narsil, "default", &english);
    insert_all(&narsil, "unfolded", &english);
    let scored = |index: &str, params: &QueryParams| -> Vec<(String, Option<f64>)> {
        narsil
            .query(index, params)
            .expect("the search answers")
            .hits
            .into_iter()
            .map(|hit| (hit.id, hit.score))
            .collect()
    };
    for params in [
        term_query("cafe"),
        term_query("café"),
        QueryParams {
            tolerance: Some(1),
            ..term_query("naive resume")
        },
        QueryParams {
            prefix: Some(true),
            ..term_query("caf")
        },
    ] {
        assert_eq!(
            scored("default", &params),
            scored("unfolded", &params),
            "{:?}",
            params.term
        );
    }
}

use narsil::{
    Bm25Params, IndexConfig, ListParams, Map, Narsil, QueryParams, ScoringMode, SortDirection,
    SortField, TermMatch, Value, parse_json,
};

const INDEX: &str = "lamps";
const COPIES: usize = 5;
const FILLER_DOCUMENTS: usize = 56;
const PAGE_LIMIT: usize = 3;
const MAX_PAGES: usize = 100;
const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

#[derive(Clone, Copy, PartialEq, Debug)]
enum ScoreClass {
    PositiveInfinity,
    Finite,
    NegativeInfinity,
    NotANumber,
}

struct Kind {
    name: &'static str,
    field: &'static str,
    class: ScoreClass,
}

const KINDS: [Kind; 6] = [
    Kind {
        name: "positive",
        field: "positive",
        class: ScoreClass::PositiveInfinity,
    },
    Kind {
        name: "plain",
        field: "plain",
        class: ScoreClass::Finite,
    },
    Kind {
        name: "zero",
        field: "neutral",
        class: ScoreClass::Finite,
    },
    Kind {
        name: "negative",
        field: "negative",
        class: ScoreClass::NegativeInfinity,
    },
    Kind {
        name: "cancelled",
        field: "both",
        class: ScoreClass::NotANumber,
    },
    Kind {
        name: "desk",
        field: "filler",
        class: ScoreClass::Finite,
    },
];

fn string_field() -> Value {
    Value::String("string".into())
}

fn engine() -> Narsil {
    let mut schema = Map::new();
    for field in ["positive", "negative", "neutral", "plain"] {
        schema.insert(field, string_field());
    }
    schema.insert("rank", Value::String("number".into()));
    let engine = Narsil::new();
    engine
        .create_index(
            INDEX,
            IndexConfig {
                schema: Value::Object(schema),
                ..IndexConfig::default()
            },
        )
        .expect("the index is created");
    let mut documents = Vec::new();
    for kind in KINDS.iter().filter(|kind| kind.name != "desk") {
        for copy in 0..COPIES {
            let mut document = Map::new();
            document.insert("id", Value::String(format!("{}-{copy:02}", kind.name)));
            let fields: &[&str] = if kind.field == "both" {
                &["positive", "negative"]
            } else {
                std::slice::from_ref(&kind.field)
            };
            for field in fields {
                document.insert(*field, Value::String("lamp light".into()));
            }
            document.insert("rank", Value::Number((documents.len() % 7) as f64));
            documents.push(document);
        }
    }
    for filler in 0..FILLER_DOCUMENTS {
        let mut document = Map::new();
        document.insert("id", Value::String(format!("desk-{filler:02}")));
        for field in ["positive", "negative", "neutral", "plain"] {
            document.insert(field, Value::String("desk".into()));
        }
        document.insert("rank", Value::Number((filler % 7) as f64));
        documents.push(document);
    }
    let inserted = engine
        .insert_batch(INDEX, documents)
        .expect("the batch is accepted");
    assert!(inserted.failed.is_empty(), "{:?}", inserted.failed);
    engine
}

fn overflowing_query() -> QueryParams {
    QueryParams {
        term: Some("lamp light".into()),
        term_match: Some(TermMatch::Any),
        boost: Some(vec![
            ("positive".into(), f64::MAX),
            ("negative".into(), -f64::MAX),
            ("neutral".into(), 0.0),
            ("plain".into(), 1.0),
        ]),
        bm25: Some(Bm25Params {
            k1: Some(0.0),
            b: Some(0.0),
            ..Bm25Params::default()
        }),
        scoring: Some(ScoringMode::Dfs),
        limit: Some(PAGE_LIMIT),
        ..QueryParams::default()
    }
}

fn expected_order() -> Vec<(String, ScoreClass)> {
    let mut expected = Vec::new();
    for kind in KINDS.iter().filter(|kind| kind.name != "desk") {
        for copy in 0..COPIES {
            expected.push((format!("{}-{copy:02}", kind.name), kind.class));
        }
    }
    expected
}

fn class_of(score: f64) -> ScoreClass {
    if score.is_nan() {
        ScoreClass::NotANumber
    } else if score == f64::INFINITY {
        ScoreClass::PositiveInfinity
    } else if score == f64::NEG_INFINITY {
        ScoreClass::NegativeInfinity
    } else {
        ScoreClass::Finite
    }
}

fn decoded_cursor(cursor: &str) -> Map {
    let mut bits = 0u32;
    let mut held = 0;
    let mut bytes = Vec::new();
    for symbol in cursor.bytes().filter(|symbol| *symbol != b'=') {
        let Some(value) = BASE64_ALPHABET.iter().position(|letter| *letter == symbol) else {
            panic!("the cursor {cursor} holds a letter outside base64");
        };
        bits = (bits << 6) | value as u32;
        held += 6;
        if held >= 8 {
            held -= 8;
            bytes.push((bits >> held) as u8);
            bits &= (1 << held) - 1;
        }
    }
    let text = String::from_utf8(bytes).expect("the cursor is UTF-8");
    match parse_json(&text).expect("the cursor is JSON") {
        Value::Object(map) => map,
        other => panic!("the cursor decodes to {other:?}"),
    }
}

fn require_version(cursor: &Map, version: f64) {
    assert_eq!(cursor.get("v"), Some(&Value::Number(version)), "{cursor:?}");
}

fn require_score_cursor(cursor: &Map, class: ScoreClass) {
    let expected_text = match class {
        ScoreClass::PositiveInfinity => Some("Infinity"),
        ScoreClass::NegativeInfinity => Some("-Infinity"),
        ScoreClass::NotANumber => Some("NaN"),
        ScoreClass::Finite => None,
    };
    match expected_text {
        Some(text) => {
            require_version(cursor, 5.0);
            assert_eq!(
                cursor.get("s"),
                Some(&Value::String(text.into())),
                "{cursor:?}"
            );
        }
        None => {
            require_version(cursor, 4.0);
            assert!(
                matches!(cursor.get("s"), Some(Value::Number(score)) if score.is_finite()),
                "{cursor:?}"
            );
        }
    }
    assert!(
        cursor.get("k").is_none() && cursor.get("o").is_none(),
        "{cursor:?}"
    );
}

#[test]
fn score_cursors_carry_version_5_only_for_a_non_finite_anchor_and_page_in_score_order() {
    let engine = engine();
    let mut params = overflowing_query();
    let mut paged: Vec<(String, ScoreClass)> = Vec::new();
    let mut anchored = Vec::new();
    for _ in 0..MAX_PAGES {
        let page = engine.query(INDEX, &params).expect("the page is served");
        for hit in &page.hits {
            let score = hit.score.expect("an unsorted search scores every hit");
            paged.push((hit.id.clone(), class_of(score)));
        }
        let Some(cursor) = page.cursor else {
            break;
        };
        let class = paged
            .last()
            .map(|(_, class)| *class)
            .expect("a page with a cursor holds hits");
        require_score_cursor(&decoded_cursor(&cursor), class);
        anchored.push(class);
        params.search_after = Some(cursor);
    }
    assert_eq!(paged, expected_order());
    for class in [
        ScoreClass::PositiveInfinity,
        ScoreClass::Finite,
        ScoreClass::NegativeInfinity,
        ScoreClass::NotANumber,
    ] {
        assert!(
            anchored.contains(&class),
            "no page ended on a {class:?} score"
        );
    }
}

#[test]
fn sorted_and_listing_cursors_stay_on_version_4() {
    let engine = engine();
    let sorted = QueryParams {
        sort: Some(vec![SortField {
            field: "rank".into(),
            direction: SortDirection::Desc,
            mode: None,
        }]),
        ..overflowing_query()
    };
    let page = engine
        .query(INDEX, &sorted)
        .expect("the sorted page is served");
    let cursor = decoded_cursor(&page.cursor.expect("a sorted page has a cursor"));
    require_version(&cursor, 4.0);
    assert!(
        cursor.get("s").is_none() && cursor.get("k").is_some(),
        "{cursor:?}"
    );

    let listed = engine
        .list_documents(
            INDEX,
            &ListParams {
                limit: Some(PAGE_LIMIT),
                ..ListParams::default()
            },
        )
        .expect("the listing is served");
    let cursor = decoded_cursor(&listed.cursor.expect("a listing page has a cursor"));
    require_version(&cursor, 4.0);
    assert!(
        cursor.get("s").is_none() && cursor.get("k").is_none(),
        "{cursor:?}"
    );
}

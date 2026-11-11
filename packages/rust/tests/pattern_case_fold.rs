use std::collections::BTreeSet;

use narsil::{IndexConfig, ListParams, Map, Narsil, Value, parse_json, write_json};

const INDEX: &str = "addresses";
const FIELD: &str = "street";
const SHARP_S: char = '\u{00DF}';
const SHARP_S_FOLD: &str = "ss";
const N_PRECEDED_BY_APOSTROPHE: char = '\u{0149}';
const N_PRECEDED_BY_APOSTROPHE_FOLD: &str = "\u{02BC}n";
const IOTA_WITH_DIALYTIKA_AND_TONOS: char = '\u{0390}';
const IOTA_WITH_DIALYTIKA_AND_TONOS_FOLD: &str = "\u{03B9}\u{0308}\u{0301}";

fn streets() -> Vec<(&'static str, String)> {
    vec![
        ("sharp-s", format!("Stra{SHARP_S}e 12")),
        ("double-s", "STRASSE 12".to_string()),
        ("single-s", "Strase 12".to_string()),
        (
            "apostrophe-n",
            format!("{N_PRECEDED_BY_APOSTROPHE}orth Gate"),
        ),
        ("modifier-apostrophe", "\u{02BC}NORTH GATE".to_string()),
        ("plain-n", "North Gate".to_string()),
        ("iota", format!("{IOTA_WITH_DIALYTIKA_AND_TONOS}ta Lane")),
        (
            "iota-in-parts",
            "\u{03B9}\u{0308}\u{0301}TA LANE".to_string(),
        ),
        ("bare-iota", "\u{03B9}ta Lane".to_string()),
    ]
}

fn fold_from_case_folding_txt(text: &str) -> String {
    let mut folded = String::new();
    for character in text.chars() {
        match character {
            SHARP_S => folded.push_str(SHARP_S_FOLD),
            N_PRECEDED_BY_APOSTROPHE => folded.push_str(N_PRECEDED_BY_APOSTROPHE_FOLD),
            IOTA_WITH_DIALYTIKA_AND_TONOS => folded.push_str(IOTA_WITH_DIALYTIKA_AND_TONOS_FOLD),
            _ => folded.push(character.to_ascii_lowercase()),
        }
    }
    folded
}

fn engine_with_streets() -> Narsil {
    let engine = Narsil::new();
    engine
        .create_index(
            INDEX,
            IndexConfig {
                schema: parse_json(&format!(r#"{{"{FIELD}": "string:pattern"}}"#))
                    .expect("the schema is JSON"),
                ..IndexConfig::default()
            },
        )
        .expect("the index is created");
    let documents: Vec<Map> = streets()
        .into_iter()
        .map(|(id, street)| {
            let mut map = Map::new();
            map.insert("id", Value::String(id.to_string()));
            map.insert(FIELD, Value::String(street));
            map
        })
        .collect();
    let result = engine
        .insert_batch(INDEX, documents)
        .expect("the batch completes");
    assert!(result.failed.is_empty());
    engine
}

fn listed(engine: &Narsil, test: &str) -> BTreeSet<String> {
    let filter = format!(r#"{{"fields": {{"{FIELD}": {test}}}}}"#);
    engine
        .list_documents(
            INDEX,
            &ListParams {
                filters: Some(parse_json(&filter).expect("the filter is JSON")),
                limit: Some(100),
                ..ListParams::default()
            },
        )
        .unwrap_or_else(|error| panic!("the listing under {filter} fails: {error:?}"))
        .documents
        .into_iter()
        .map(|document| document.id)
        .collect()
}

fn kept_by(keep: impl Fn(&str) -> bool) -> BTreeSet<String> {
    streets()
        .into_iter()
        .filter(|(_, street)| keep(&fold_from_case_folding_txt(street)))
        .map(|(id, _)| id.to_string())
        .collect()
}

fn ids(wanted: &[&str]) -> BTreeSet<String> {
    wanted.iter().map(|id| id.to_string()).collect()
}

#[test]
fn a_folded_pattern_test_matches_every_value_whose_case_fold_expands_to_the_same_code_points() {
    let engine = engine_with_streets();
    let texts = [
        "STRASSE 12".to_string(),
        format!("stra{SHARP_S}e 12"),
        format!("{N_PRECEDED_BY_APOSTROPHE}ORTH gate"),
        "\u{02BC}north GATE".to_string(),
        format!("{IOTA_WITH_DIALYTIKA_AND_TONOS}TA lane"),
        "\u{03B9}\u{0308}\u{0301}ta LANE".to_string(),
        "ASSE".to_string(),
        format!("A{SHARP_S}E"),
        "\u{02BC}N".to_string(),
        N_PRECEDED_BY_APOSTROPHE.to_string(),
        "\u{0308}\u{0301}T".to_string(),
        IOTA_WITH_DIALYTIKA_AND_TONOS.to_string(),
    ];
    for text in &texts {
        let wanted = fold_from_case_folding_txt(text);
        let quoted = write_json(&Value::String(text.clone()));
        for (operator, expected) in [
            ("eq", kept_by(|street| street == wanted)),
            ("contains", kept_by(|street| street.contains(&wanted))),
            ("startsWith", kept_by(|street| street.starts_with(&wanted))),
            ("endsWith", kept_by(|street| street.ends_with(&wanted))),
        ] {
            assert_eq!(
                listed(
                    &engine,
                    &format!(r#"{{"{operator}": {quoted}, "caseFold": true}}"#)
                ),
                expected,
                "{operator} {text:?} with caseFold"
            );
        }
    }
    assert_eq!(
        listed(&engine, r#"{"eq": "STRASSE 12"}"#),
        ids(&["double-s"]),
        "eq without caseFold compares the stored code points"
    );
    assert_eq!(
        listed(
            &engine,
            &format!(r#"{{"regex": "stra({SHARP_S}|x)e [0-9]+", "caseFold": true}}"#)
        ),
        ids(&["double-s", "sharp-s"]),
        "a folded expression matches the fold of its literal"
    );
    assert_eq!(
        listed(
            &engine,
            &format!(r#"{{"eq": "Stra{SHARP_S}e 13", "tolerance": 1, "caseFold": true}}"#)
        ),
        ids(&["double-s", "sharp-s"]),
        "a typo tolerant eq counts its edits on the folded code points"
    );
}

use std::collections::BTreeMap;

use narsil::{IndexConfig, ListParams, Map, Narsil, Value, parse_json};

const INDEX: &str = "filings";
const FIELD: &str = "body";
const DOCUMENTS_PER_STAGE: u64 = 1_000;
const STAGES: u64 = 3;
const DOCUMENTS_WITHOUT_BODY: u64 = 300;
const BODY_CODE_POINTS: usize = 4_000;
const DOCKET_PREFIX: &str = "K7Q-";
const DOCKET_DIGITS: usize = 4;
const DOCKETED_EVERY: u64 = 7;
const LAST_DIGIT_SOUGHT: char = '5';
const DOCKET_REGEX: &str = r#"{"fields": {"body": {"regex": "K7Q-[0-9]{3}5"}}}"#;
const MAX_LISTED: usize = 10_000;
const FILLER_SEED: u64 = 0x2545_F491_4F6C_DD1D;
const FILLER_STEP: u64 = 0x9E37_79B9_7F4A_7C15;
const WORD_GAP_EVERY: u64 = 7;
const REMOVED_FROM_FROZEN_EVERY: u64 = 4;

fn id_of(number: u64) -> String {
    format!("filing-{number:05}")
}

fn body_of(number: u64) -> String {
    let mut state = FILLER_SEED ^ number.wrapping_mul(FILLER_STEP);
    let mut body: String = (0..BODY_CODE_POINTS)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            if state.is_multiple_of(WORD_GAP_EVERY) {
                ' '
            } else {
                char::from(b'a' + ((state >> 8) % 26) as u8)
            }
        })
        .collect();
    if number.is_multiple_of(DOCKETED_EVERY) {
        let docket = format!(
            "{DOCKET_PREFIX}{:0width$}",
            number % 10_000,
            width = DOCKET_DIGITS
        );
        let at = (number as usize * 37) % (BODY_CODE_POINTS - docket.len());
        body.replace_range(at..at + docket.len(), &docket);
    }
    body
}

fn filing(number: u64) -> Map {
    let mut map = Map::new();
    map.insert("id", Value::String(id_of(number)));
    map.insert("title", Value::String(format!("filing {number}")));
    map.insert(FIELD, Value::String(body_of(number)));
    map
}

fn untitled_note(number: u64) -> Map {
    let mut map = Map::new();
    map.insert("id", Value::String(format!("note-{number:05}")));
    map.insert("title", Value::String(format!("note {number}")));
    map
}

fn docket_matches(body: &str) -> bool {
    body.match_indices(DOCKET_PREFIX).any(|(at, _)| {
        let digits: Vec<char> = body[at + DOCKET_PREFIX.len()..]
            .chars()
            .take(DOCKET_DIGITS)
            .collect();
        digits.len() == DOCKET_DIGITS
            && digits.iter().all(char::is_ascii_digit)
            && digits.last() == Some(&LAST_DIGIT_SOUGHT)
    })
}

fn expected_hits(live: &BTreeMap<String, String>) -> Vec<String> {
    live.iter()
        .filter(|(_, body)| docket_matches(body))
        .map(|(id, _)| id.clone())
        .collect()
}

fn regex_hits(engine: &Narsil) -> (u64, Vec<String>) {
    let listed = engine
        .list_documents(
            INDEX,
            &ListParams {
                filters: Some(parse_json(DOCKET_REGEX).expect("the filter is JSON")),
                limit: Some(MAX_LISTED),
                ..ListParams::default()
            },
        )
        .expect("the regex listing answers");
    let ids = listed
        .documents
        .into_iter()
        .map(|document| document.id)
        .collect();
    (listed.total, ids)
}

fn require_oracle_hits(engine: &Narsil, live: &BTreeMap<String, String>, when: &str) -> usize {
    let wanted = expected_hits(live);
    let (total, ids) = regex_hits(engine);
    assert_eq!(
        ids, wanted,
        "{when}: the regex hits differ from a scan of every live body"
    );
    assert_eq!(
        total,
        wanted.len() as u64,
        "{when}: the regex count differs from the scan"
    );
    wanted.len()
}

fn insert(engine: &Narsil, batch: Vec<Map>) {
    let result = engine
        .insert_batch(INDEX, batch)
        .expect("the batch completes");
    assert!(
        result.failed.is_empty(),
        "the crate refused {:?}",
        result.failed
    );
}

fn remove(engine: &Narsil, live: &mut BTreeMap<String, String>, number: u64) {
    let id = id_of(number);
    engine.remove(INDEX, &id).expect("the filing is removed");
    live.remove(&id);
}

fn insert_stage(engine: &Narsil, live: &mut BTreeMap<String, String>, stage: u64) {
    let numbers = stage * DOCUMENTS_PER_STAGE..(stage + 1) * DOCUMENTS_PER_STAGE;
    insert(engine, numbers.clone().map(filing).collect());
    for number in numbers.clone() {
        live.insert(id_of(number), body_of(number));
    }
    for number in numbers.filter(|&number| number % 3 == 0 && docket_matches(&body_of(number))) {
        remove(engine, live, number);
    }
}

#[test]
fn a_regex_search_after_merging_segments_that_searches_reached_unevenly_finds_every_live_match() {
    let engine = Narsil::new();
    engine
        .create_index(
            INDEX,
            IndexConfig {
                schema: parse_json(r#"{"title": "string", "body": "string:pattern"}"#)
                    .expect("the schema is JSON"),
                ..IndexConfig::default()
            },
        )
        .expect("the index is created");
    let mut live: BTreeMap<String, String> = BTreeMap::new();
    insert_stage(&engine, &mut live, 0);
    let first = require_oracle_hits(&engine, &live, "before the first freeze");
    engine
        .freeze_tail_segments(INDEX)
        .expect("the tail freezes");
    insert_stage(&engine, &mut live, 1);
    for number in (0..DOCUMENTS_PER_STAGE).filter(|number| number % REMOVED_FROM_FROZEN_EVERY == 1)
    {
        if live.contains_key(&id_of(number)) {
            remove(&engine, &mut live, number);
        }
    }
    engine
        .freeze_tail_segments(INDEX)
        .expect("the tail freezes");
    let between = require_oracle_hits(&engine, &live, "between freezes");
    insert(
        &engine,
        (0..DOCUMENTS_WITHOUT_BODY).map(untitled_note).collect(),
    );
    engine
        .freeze_tail_segments(INDEX)
        .expect("the tail freezes");
    for stage in 2..STAGES {
        insert_stage(&engine, &mut live, stage);
    }
    let with_tail = require_oracle_hits(&engine, &live, "with a tail over frozen segments");
    engine
        .freeze_tail_segments(INDEX)
        .expect("the tail freezes");
    let frozen = require_oracle_hits(&engine, &live, "with every segment frozen");
    engine
        .merge_partition_segments(INDEX)
        .expect("the segments merge");
    let merged = require_oracle_hits(&engine, &live, "after the merge");
    assert!(
        first > 0 && between > first && with_tail > between,
        "each stage adds regex matches for the merge to keep"
    );
    assert_eq!(frozen, merged, "the merge changes the regex count");
}

use std::collections::{BTreeMap, HashSet};

use narsil::conformance::read_sample;
use narsil::{IndexConfig, Map, Narsil, Value, parse_json};

const INDEX: &str = "catalogue";
const DOCUMENTS_PER_STAGE: usize = 12;
const STAGES: usize = 3;
const AXIS_BITS: u32 = 26;
const PATTERN_RUN_LENGTH: usize = 3;
const CATEGORIES: [&str; 5] = ["alpha", "beta", "\u{FF5E}wave", "\u{1F600}smile", "zeta"];

fn document(at: usize) -> Map {
    let category = CATEGORIES[at % CATEGORIES.len()];
    let price = match at % 4 {
        0 => -(at as f64),
        1 => 12.5,
        _ => (at * 7 % 11) as f64,
    };
    let text = format!(
        r#"{{"id": "doc-{at:03}", "title": "item {at}", "code": "Ab-{}-Cd{}", "category": "{category}", "price": {price}, "active": {}, "location": {{"lat": {}, "lon": {}}}}}"#,
        at % 9,
        at % 4,
        at.is_multiple_of(3),
        (at as f64 * 13.0) % 180.0 - 90.0,
        (at as f64 * 29.0) % 360.0 - 180.0,
    );
    parse_json(&text)
        .expect("the document is JSON")
        .as_object()
        .cloned()
        .expect("the document is an object")
}

fn number_list(value: Option<&Value>) -> Vec<f64> {
    value
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_f64).collect())
        .unwrap_or_default()
}

fn ordinal_list(value: Option<&Value>) -> Vec<u32> {
    number_list(value).into_iter().map(|n| n as u32).collect()
}

fn column<'p>(payload: &'p Map, kind: &str, field: &str) -> &'p Map {
    payload
        .get(kind)
        .and_then(Value::as_array)
        .and_then(|columns| {
            columns
                .iter()
                .filter_map(Value::as_object)
                .find(|column| column.get("field").and_then(Value::as_str) == Some(field))
        })
        .unwrap_or_else(|| panic!("the merged segment holds a {kind} column for {field}"))
}

fn axis_cell(value: f64, lowest: f64, span: f64) -> u64 {
    let cells = (1u64 << AXIS_BITS) as f64;
    let cell = ((value - lowest) / span * cells).floor();
    cell.clamp(0.0, cells - 1.0) as u64
}

fn interleaved_cell(latitude: f64, longitude: f64) -> u64 {
    let row = axis_cell(latitude, -90.0, 180.0);
    let column = axis_cell(longitude, -180.0, 360.0);
    let mut code = 0u64;
    for bit in (0..AXIS_BITS).rev() {
        code = (code << 2) | (((row >> bit) & 1) << 1) | ((column >> bit) & 1);
    }
    code
}

fn merged_payload(removals: &[(usize, usize)]) -> Map {
    let engine = Narsil::new();
    let schema = parse_json(
        r#"{"title": "string", "code": "string:pattern", "category": "enum", "price": "number", "active": "boolean", "location": "geopoint"}"#,
    )
    .expect("the schema is JSON");
    engine
        .create_index(
            INDEX,
            IndexConfig {
                schema,
                ..IndexConfig::default()
            },
        )
        .expect("the index is created");
    for stage in 0..STAGES {
        let batch: Vec<Map> = (stage * DOCUMENTS_PER_STAGE..(stage + 1) * DOCUMENTS_PER_STAGE)
            .map(document)
            .collect();
        let result = engine
            .insert_batch(INDEX, batch)
            .expect("the batch is inserted");
        assert!(
            result.failed.is_empty(),
            "the crate refused {:?}",
            result.failed
        );
        for &(_, at) in removals.iter().filter(|(during, _)| *during == stage) {
            engine
                .remove(INDEX, &format!("doc-{at:03}"))
                .expect("the document is removed");
        }
        if stage + 1 < STAGES {
            engine
                .freeze_tail_segments(INDEX)
                .expect("the tail freezes");
        }
    }
    engine
        .merge_partition_segments(INDEX)
        .expect("the segments merge");
    let mut files = engine
        .keyword_segment_files(INDEX)
        .expect("the segments are written");
    let partition = files.pop().expect("the index holds a partition");
    assert_eq!(partition.len(), 1, "the merge leaves one segment");
    read_sample("keyword-segment", &partition[0], None)
        .expect("the merged segment reads back")
        .pointer("payload")
        .and_then(Value::as_object)
        .cloned()
        .expect("the form holds a payload")
}

#[test]
fn merging_frozen_segments_and_a_tail_keeps_every_field_column_of_the_live_documents() {
    let removals = [
        (0, 0),
        (0, 4),
        (1, 9),
        (1, 15),
        (2, 3),
        (2, 17),
        (2, 23),
        (2, 30),
        (2, 34),
    ];
    let removed: HashSet<String> = removals
        .iter()
        .map(|(_, at)| format!("doc-{at:03}"))
        .collect();
    let payload = merged_payload(&removals);
    let ids: Vec<String> = payload
        .get("ids")
        .and_then(Value::as_array)
        .expect("the payload lists its IDs")
        .iter()
        .map(|id| id.as_str().expect("an ID is text").to_string())
        .collect();
    let live: Vec<(u32, Map)> = ids
        .iter()
        .enumerate()
        .map(|(ordinal, id)| {
            let at: usize = id[4..].parse().expect("an ID ends in its number");
            (ordinal as u32, document(at))
        })
        .collect();
    let mut wanted_ids: Vec<String> = (0..STAGES * DOCUMENTS_PER_STAGE)
        .map(|at| format!("doc-{at:03}"))
        .filter(|id| !removed.contains(id))
        .collect();
    let mut found_ids = ids.clone();
    wanted_ids.sort();
    found_ids.sort();
    assert_eq!(
        found_ids, wanted_ids,
        "the merge keeps exactly the live documents"
    );

    let mut prices: Vec<(f64, u32)> = live
        .iter()
        .map(|(ordinal, doc)| {
            (
                doc.get("price").and_then(Value::as_f64).unwrap_or(0.0),
                *ordinal,
            )
        })
        .collect();
    prices.sort_by(|left, right| left.0.total_cmp(&right.0).then(left.1.cmp(&right.1)));
    let price = column(&payload, "numeric", "price");
    assert_eq!(
        ordinal_list(price.get("documents")),
        prices.iter().map(|p| p.1).collect::<Vec<_>>()
    );
    assert_eq!(
        number_list(price.get("values")),
        prices.iter().map(|p| p.0).collect::<Vec<_>>()
    );

    let active = column(&payload, "boolean", "active");
    let holding = |wanted: bool| -> Vec<u32> {
        live.iter()
            .filter(|(_, doc)| doc.get("active").and_then(Value::as_bool) == Some(wanted))
            .map(|(ordinal, _)| *ordinal)
            .collect()
    };
    assert_eq!(ordinal_list(active.get("trueDocuments")), holding(true));
    assert_eq!(ordinal_list(active.get("falseDocuments")), holding(false));

    let category = column(&payload, "enum", "category");
    let values: Vec<String> = category
        .get("values")
        .and_then(Value::as_array)
        .expect("the enum column lists its values")
        .iter()
        .map(|value| value.as_str().expect("a value is text").to_string())
        .collect();
    let units: Vec<Vec<u16>> = values
        .iter()
        .map(|value| value.encode_utf16().collect())
        .collect();
    assert!(
        units.windows(2).all(|pair| pair[0] < pair[1]),
        "the enum values follow UTF-16 code unit order: {values:?}"
    );
    let offsets = ordinal_list(category.get("offsets"));
    let postings = ordinal_list(category.get("documents"));
    let mut found_members: BTreeMap<String, Vec<u32>> = BTreeMap::new();
    for (at, value) in values.iter().enumerate() {
        let members = postings[offsets[at] as usize..offsets[at + 1] as usize].to_vec();
        if !members.is_empty() {
            found_members.insert(value.clone(), members);
        }
    }
    let mut wanted_members: BTreeMap<String, Vec<u32>> = BTreeMap::new();
    for (ordinal, doc) in &live {
        let value = doc
            .get("category")
            .and_then(Value::as_str)
            .unwrap_or_default();
        wanted_members
            .entry(value.to_string())
            .or_default()
            .push(*ordinal);
    }
    assert_eq!(found_members, wanted_members);

    let location = column(&payload, "geopoint", "location");
    let mut rows: Vec<(u64, u32, f64, f64)> = live
        .iter()
        .map(|(ordinal, doc)| {
            let place = doc.get("location").and_then(Value::as_object);
            let lat = place
                .and_then(|place| place.get("lat"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let lon = place
                .and_then(|place| place.get("lon"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            (interleaved_cell(lat, lon), *ordinal, lat, lon)
        })
        .collect();
    rows.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.cmp(&right.1)));
    assert_eq!(
        ordinal_list(location.get("documents")),
        rows.iter().map(|r| r.1).collect::<Vec<_>>()
    );
    assert_eq!(
        number_list(location.get("latitudes")),
        rows.iter().map(|r| r.2).collect::<Vec<_>>()
    );
    assert_eq!(
        number_list(location.get("longitudes")),
        rows.iter().map(|r| r.3).collect::<Vec<_>>()
    );

    let mut runs: BTreeMap<Vec<u32>, Vec<u32>> = BTreeMap::new();
    for (ordinal, doc) in &live {
        let code: Vec<u32> = doc
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase()
            .chars()
            .map(u32::from)
            .collect();
        let distinct: HashSet<Vec<u32>> = code
            .windows(PATTERN_RUN_LENGTH)
            .map(<[u32]>::to_vec)
            .collect();
        for run in distinct {
            runs.entry(run).or_default().push(*ordinal);
        }
    }
    let pattern = column(&payload, "pattern", "code");
    let all_live: Vec<u32> = live.iter().map(|(ordinal, _)| *ordinal).collect();
    assert_eq!(ordinal_list(pattern.get("documents")), all_live);
    let wanted_runs: Vec<u32> = runs.keys().flatten().copied().collect();
    let mut wanted_offsets = vec![0u32];
    let mut wanted_postings = Vec::new();
    for members in runs.values() {
        wanted_postings.extend_from_slice(members);
        wanted_offsets.push(wanted_postings.len() as u32);
    }
    assert_eq!(ordinal_list(pattern.get("runs")), wanted_runs);
    assert_eq!(ordinal_list(pattern.get("offsets")), wanted_offsets);
    assert_eq!(ordinal_list(pattern.get("postings")), wanted_postings);
}

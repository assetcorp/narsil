mod support;

use narsil::{Value, parse_json};
use support::shaping_compare::{require_parity, step};

const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn highlighted_queries() -> Vec<(Value, usize)> {
    vec![
        step(
            r#"{"term": "tax", "highlight": {"fields": ["title", "summary"]}}"#,
            2,
        ),
        step(
            r#"{"term": "the tax credits", "highlight": {"fields": ["summary"], "maxSnippetLength": 0}}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "highlight": {"fields": ["summary"], "maxSnippetLength": 30}}"#,
            1,
        ),
        step(
            r#"{"term": "zzzqqq coin", "highlight": {"fields": ["summary"], "maxSnippetLength": 25}}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "highlight": {"fields": ["title"], "preTag": "[", "postTag": "]", "maxSnippetLength": 1000}}"#,
            1,
        ),
        step(
            r#"{"term": "tax cred", "prefix": true, "highlight": {"fields": ["summary"]}}"#,
            1,
        ),
        step(
            r#"{"term": "taxe", "tolerance": 1, "highlight": {"fields": ["title", "summary"]}}"#,
            1,
        ),
        step(
            r#"{"term": "taxe", "tolerance": 2, "prefixLength": 0, "highlight": {"fields": ["title"]}}"#,
            1,
        ),
        step(
            r#"{"term": "taxes", "exact": true, "tolerance": 1, "highlight": {"fields": ["summary"]}}"#,
            1,
        ),
        step(
            r#"{"term": "\"internal revenue code\" amend", "highlight": {"fields": ["summary"]}}"#,
            1,
        ),
        step(
            r#"{"term": "\"internal revenue\"", "prefix": true, "highlight": {"fields": ["summary"]}}"#,
            1,
        ),
        step(
            r#"{"term": "venue", "partialWords": true, "highlight": {"fields": ["summary", "title"]}}"#,
            1,
        ),
        step(
            r#"{"term": "struct", "partialWords": true, "prefix": true, "highlight": {"fields": ["summary"]}}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "document": false, "highlight": {"fields": ["title"]}, "limit": 3}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "document": {"include": ["title"]}, "highlight": {"fields": ["summary"]}, "limit": 3}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "highlight": {"fields": ["year", "sponsor.name", "absent", "pages", "title", "title"]}, "limit": 3}"#,
            1,
        ),
        step(
            r#"{"term": "tax alpha", "highlight": {"fields": ["code", "sponsor"]}, "limit": 200}"#,
            1,
        ),
        step(
            r#"{"term": "tax istanbul emile σοφος alpha", "highlight": {"fields": ["code"], "maxSnippetLength": 8}, "limit": 200}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "sort": {"year": "desc"}, "highlight": {"fields": ["title"]}, "limit": 4}"#,
            2,
        ),
        step(
            r#"{"term": "tax", "group": {"fields": ["chamber"], "maxPerGroup": 3}, "highlight": {"fields": ["title"]}}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "pinned": [{"docId": "train-00000", "position": 0}], "group": {"fields": ["chamber"]}, "highlight": {"fields": ["title"]}, "limit": 4}"#,
            1,
        ),
        step(r#"{"term": "", "highlight": {"fields": ["title"]}}"#, 1),
        step(
            r#"{"term": "tax", "highlight": {"fields": []}, "limit": 2}"#,
            1,
        ),
    ]
}

#[test]
fn highlighted_queries_tag_exactly_as_the_reference_does() {
    require_parity(highlighted_queries());
}

fn forged(json: &str) -> String {
    let mut encoded = String::new();
    for chunk in json.as_bytes().chunks(3) {
        let bits = chunk.iter().enumerate().fold(0u32, |bits, (at, byte)| {
            bits | (u32::from(*byte) << (16 - 8 * at))
        });
        for place in 0..4 {
            if place <= chunk.len() {
                encoded.push(char::from(
                    BASE64_ALPHABET[((bits >> (18 - 6 * place)) & 63) as usize],
                ));
            } else {
                encoded.push('=');
            }
        }
    }
    encoded
}

fn with_cursor(base: &str, cursor: &str) -> (Value, usize) {
    let mut query = parse_json(base).expect("the query is JSON");
    if let Some(map) = query.as_object_mut() {
        map.insert("searchAfter", Value::String(cursor.to_string()));
    }
    (query, 1)
}

fn hostile_cursor_queries() -> Vec<(Value, usize)> {
    let unsorted = r#"{"term": "tax"}"#;
    vec![
        with_cursor(unsorted, "garbage"),
        with_cursor(unsorted, ""),
        with_cursor(r#"{"term": "tax", "sort": {"year": "asc"}}"#, ""),
        with_cursor(unsorted, &"A".repeat(40_961)),
        with_cursor(unsorted, &forged(r#"{"v":3,"a":"x","s":1,"q":"00000000"}"#)),
        with_cursor(unsorted, &forged(r#"{"v":4,"a":"x","s":1,"q":"00000000"}"#)),
        with_cursor(unsorted, &forged(r#"{"v":4,"a":"","s":1,"q":"0000000g"}"#)),
        with_cursor(
            unsorted,
            &forged(r#"{"v":4,"a":"x","s":"1","q":"00000000"}"#),
        ),
        with_cursor(
            unsorted,
            &forged(r#"{"v":4,"a":"x","s":1,"k":[],"q":"00000000"}"#),
        ),
        with_cursor(
            unsorted,
            &forged(r#"{"v":4,"a":"x","k":[{}],"o":"[]","q":"00000000"}"#),
        ),
        with_cursor(
            unsorted,
            &forged(r#"{"v":4,"a":"x","k":[1],"q":"00000000"}"#),
        ),
        with_cursor(
            unsorted,
            &forged(r#"{"v":4,"a":"x","s":1,"d":0,"q":"00000000"}"#),
        ),
        with_cursor(
            unsorted,
            &forged(r#"{"v":5,"a":"x","s":"NaN","q":"00000000"}"#),
        ),
        with_cursor(
            unsorted,
            &forged(r#"{"v":5,"a":"x","s":"-Infinity","d":4,"q":"00000000"}"#),
        ),
        with_cursor(unsorted, &forged(r#"{"v":5,"a":"x","s":1,"q":"00000000"}"#)),
        with_cursor(
            unsorted,
            &forged(r#"{"v":5,"a":"x","s":"inf","q":"00000000"}"#),
        ),
        with_cursor(unsorted, &forged(r#"{"v":5,"a":"x","q":"00000000"}"#)),
        with_cursor(
            unsorted,
            &forged(r#"{"v":5,"a":"x","s":"Infinity","k":[1],"o":"[]","q":"00000000"}"#),
        ),
        with_cursor(
            unsorted,
            &forged(r#"{"v":4,"a":"x","s":"NaN","q":"00000000"}"#),
        ),
        with_cursor(
            unsorted,
            &forged(r#"{"v":6,"a":"x","s":"NaN","q":"00000000"}"#),
        ),
        with_cursor(unsorted, &forged(r#"[1,2]"#)),
        with_cursor(unsorted, "eyJ2Ijo0LCJhIjoieCIsInMiOjEsInEiOiIwMDAwMDAwMCJ9"),
        with_cursor(
            unsorted,
            "eyJ2Ijo0LCJhIjoieCIsInMiOjEsInEiOiIwMDAwMDAwMCJ9!!",
        ),
        with_cursor(
            unsorted,
            "e-y_J2Ijo0LCJhIjoieCIsInMiOjEsInEiOiIwMDAwMDAwMCJ9",
        ),
        step(
            r#"{"term": "tax", "limit": 3, "$next": {"term": "health"}}"#,
            2,
        ),
        step(
            r#"{"term": "tax", "limit": 3, "$next": {"sort": {"year": "asc"}}}"#,
            2,
        ),
        step(
            r#"{"term": "tax", "sort": {"year": "asc"}, "limit": 3, "$next": {"sort": {"year": "desc"}}}"#,
            2,
        ),
        step(
            r#"{"term": "tax", "sort": {"year": "asc"}, "limit": 3, "$next": {"sort": {}}}"#,
            2,
        ),
        step(
            r#"{"term": "tax", "limit": 3, "$next": {"pinned": [{"docId": "train-00000", "position": 0}]}}"#,
            2,
        ),
        step(
            r#"{"term": "tax", "limit": 3, "$next": {"includeScores": false, "facets": {"chamber": {}}}}"#,
            2,
        ),
        step(
            r#"{"term": "tax", "sort": {"year": "asc"}, "limit": 3, "$next": {"includeScores": true}}"#,
            2,
        ),
    ]
}

#[test]
fn hostile_cursors_fail_exactly_as_the_reference_does() {
    require_parity(hostile_cursor_queries());
}

mod support;

use narsil::Value;
use support::shaping_compare::{require_parity, require_spread_parity, step};

fn sorted_queries() -> Vec<(Value, usize)> {
    vec![
        step(
            r#"{"term": "tax", "sort": {"year": "desc"}, "limit": 7}"#,
            4,
        ),
        step(
            r#"{"term": "tax", "sort": {"title": "asc"}, "limit": 10}"#,
            3,
        ),
        step(
            r#"{"term": "education", "sort": [{"field": "pages", "direction": "asc"}]}"#,
            3,
        ),
        step(
            r#"{"term": "education", "sort": [{"field": "pages", "direction": "desc", "mode": "avg"}]}"#,
            3,
        ),
        step(
            r#"{"term": "education", "sort": [{"field": "pages", "direction": "asc", "mode": "median"}]}"#,
            3,
        ),
        step(
            r#"{"term": "education", "sort": [{"field": "pages", "direction": "desc", "mode": "min"}]}"#,
            3,
        ),
        step(
            r#"{"term": "tax", "sort": {"code": "asc"}, "limit": 20}"#,
            5,
        ),
        step(
            r#"{"term": "tax", "sort": {"code": "desc"}, "limit": 20}"#,
            3,
        ),
        step(
            r#"{"term": "tax", "sort": {"sponsor.rank": "desc", "sponsor.name": "asc"}}"#,
            3,
        ),
        step(
            r#"{"term": "tax", "sort": {"chamber": "asc", "enacted": "desc", "year": "asc", "code": "asc"}}"#,
            3,
        ),
        step(
            r#"{"term": "health", "sort": {"votes": "asc"}, "limit": 15}"#,
            3,
        ),
        step(
            r#"{"term": "health", "sort": [{"field": "topics", "direction": "desc"}], "limit": 15}"#,
            3,
        ),
        step(
            r#"{"term": "tax", "sort": {"year": "asc"}, "offset": 15, "limit": 5}"#,
            3,
        ),
        step(
            r#"{"term": "tax", "sort": {"year": "asc"}, "includeScores": true, "limit": 5}"#,
            3,
        ),
        step(
            r#"{"term": "coin", "sort": {"year": "asc"}, "includeScoreComponents": true, "limit": 4}"#,
            2,
        ),
        step(
            r#"{"term": "tax", "sort": {"year": "desc"}, "minScore": 4, "limit": 5}"#,
            3,
        ),
        step(
            r#"{"term": "tax credit", "sort": {"year": "desc"}, "termMatch": "all", "limit": 5}"#,
            3,
        ),
        step(r#"{"term": "tax", "sort": {"year": "asc"}, "limit": 0}"#, 2),
        step(
            r#"{"term": "tax", "sort": {"year": "asc"}, "limit": 3, "$next": {"limit": 6}}"#,
            3,
        ),
        step(
            r#"{"term": "tax", "sort": {"year": "asc"}, "limit": 4, "$next": {"offset": 2}}"#,
            3,
        ),
        step(
            r#"{"term": "tax", "sort": {"year": "asc"}, "document": false, "limit": 3}"#,
            2,
        ),
        step(r#"{"term": "", "sort": {"year": "asc"}}"#, 1),
        step(r#"{"term": "   ", "sort": {"year": "asc"}}"#, 1),
        step(r#"{"term": "zzzqqq", "sort": {"year": "asc"}}"#, 1),
        step(r#"{"term": "tax", "sort": {"weight": "asc"}}"#, 1),
        step(r#"{"term": "tax", "sort": {"summary": "asc"}}"#, 1),
        step(r#"{"term": "tax", "sort": {"sponsor": "asc"}}"#, 1),
        step(r#"{"term": "tax", "sort": {"absent.path": "asc"}}"#, 1),
        step(
            r#"{"term": "tax", "sort": {"year": "asc", "pages": "asc", "code": "asc", "title": "asc", "chamber": "asc", "enacted": "asc", "votes": "asc", "topics": "asc", "sponsor.rank": "asc"}}"#,
            1,
        ),
        step(
            &format!(
                r#"{{"term": "tax", "sort": {{"{}": "asc"}}}}"#,
                "y".repeat(256)
            ),
            1,
        ),
        step(
            r#"{"term": "tax", "sort": {"year": "asc"}, "limit": 10001}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "sort": {"year": "asc"}, "offset": 9995, "limit": 6}"#,
            1,
        ),
    ]
}

#[test]
fn sorted_queries_page_exactly_as_the_reference_does() {
    require_parity(sorted_queries());
}

fn pinned_and_grouped_queries() -> Vec<(Value, usize)> {
    vec![
        step(r#"{"term": "tax", "limit": 5}"#, 4),
        step(r#"{"term": "tax", "limit": 5, "offset": 3}"#, 3),
        step(
            r#"{"term": "coin", "limit": 3, "includeScoreComponents": true}"#,
            2,
        ),
        step(r#"{"term": "tax", "limit": 5, "minScore": 5}"#, 3),
        step(r#"{"term": "tax", "limit": 5, "termMatch": "all"}"#, 2),
        step(
            r#"{"term": "tax", "limit": 6, "pinned": [{"docId": "train-00000", "position": 0}, {"docId": "missing-document", "position": 2}, {"docId": "train-00002", "position": 50}]}"#,
            3,
        ),
        step(
            r#"{"term": "tax", "limit": 4, "pinned": [{"docId": "train-00001", "position": 3}, {"docId": "train-00001", "position": 1}, {"docId": "train-00003", "position": 1}]}"#,
            2,
        ),
        step(
            r#"{"term": "tax", "sort": {"year": "desc"}, "limit": 4, "pinned": [{"docId": "train-00004", "position": 1}]}"#,
            3,
        ),
        step(
            r#"{"term": "tax", "minScore": 5, "limit": 3, "pinned": [{"docId": "train-00000", "position": 1}, {"docId": "train-00001", "position": 0}]}"#,
            2,
        ),
        step(
            r#"{"term": "tax", "group": {"fields": ["chamber"], "maxPerGroup": 3, "reduce": "scoreSum"}}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "group": {"fields": ["chamber", "enacted"], "limit": 2, "reduce": "yearList"}}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "group": {"fields": ["topics"], "maxPerGroup": 2}}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "group": {"fields": ["sponsor"], "reduce": "failsOnOddYear"}}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "group": {"fields": ["note", "weight"], "maxPerGroup": 2}}"#,
            1,
        ),
        step(r#"{"term": "tax", "group": {"fields": []}, "limit": 3}"#, 1),
        step(
            r#"{"term": "tax", "group": {"fields": ["absent"], "maxPerGroup": 0}}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "group": {"fields": ["chamber"], "limit": 0}}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "group": {"fields": ["chamber", "chamber"]}, "limit": 4}"#,
            2,
        ),
        step(
            r#"{"term": "tax", "group": {"fields": ["year"]}, "sort": {"year": "asc"}, "limit": 5}"#,
            2,
        ),
        step(r#"{"term": "tax", "group": {"fields": ["summary"]}}"#, 1),
        step(
            r#"{"term": "tax", "group": {"fields": ["topics", "year"], "maxPerGroup": 2, "limit": 3}, "filters": {"fields": {"chamber": {"eq": "late"}}}}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "group": {"fields": ["sponsor.rank"], "reduce": "scoreSum"}, "limit": 3}"#,
            2,
        ),
        step(
            r#"{"term": "tax", "document": {"include": ["title", "sponsor.rank"]}, "limit": 3}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "document": {"exclude": ["summary", "sponsor.name"]}, "limit": 3}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "document": {"include": ["sponsor"], "exclude": ["sponsor.name"]}, "limit": 3}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "document": {"include": []}, "limit": 2}"#,
            1,
        ),
        step(r#"{"term": "tax", "document": false, "limit": 2}"#, 1),
    ]
}

#[test]
fn pinned_and_grouped_queries_answer_exactly_as_the_reference_does() {
    require_parity(pinned_and_grouped_queries());
}

fn facet_queries() -> Vec<(Value, usize)> {
    vec![
        step(
            r#"{"term": "tax", "facets": {"chamber": {}, "topics": {}, "enacted": {}, "votes": {}, "code": {}, "sponsor.rank": {}}}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "facets": {"note": {}, "weight": {}, "sponsor": {}, "absent": {}}}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "facets": {"year": {"ranges": [{"from": 1970, "to": 1990}, {"from": 1990, "to": 2020}, {"from": 1985, "to": 1986}]}}}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "facets": {"pages": {"ranges": [{"from": 0, "to": 100}, {"from": 0, "to": 100}, {"from": -1, "to": 0.5}, {"from": 200, "to": 100}]}}}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "facets": {"weight": {"ranges": [{"from": 0, "to": 20}, {"from": 20, "to": 60}]}}}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "facets": {"chamber": {"ranges": [{"from": 0, "to": 1}]}}}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "facets": {"year": {"limit": 3}, "code": {"limit": 2, "sort": "asc"}}}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "facets": {"pages": {"sort": "asc", "limit": 5}}}"#,
            1,
        ),
        step(r#"{"term": "", "facets": {"chamber": {}}}"#, 1),
        step(r#"{"term": "zzzqqq", "facets": {"chamber": {}}}"#, 1),
        step(
            r#"{"term": "tax", "facets": {"chamber": {}}, "minScore": 5}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "facets": {"chamber": {}}, "termMatch": "all"}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "facets": {"chamber": {}}, "sort": {"year": "asc"}, "limit": 3}"#,
            2,
        ),
        step(
            r#"{"term": "tax", "facets": {"chamber": {}}, "group": {"fields": ["chamber"]}}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "facets": {"chamber": {}}, "limit": 4}"#,
            2,
        ),
        step(r#"{"term": "tax", "facets": {"summary": {"limit": 3}}}"#, 1),
    ]
}

#[test]
fn faceted_queries_count_exactly_as_the_reference_does() {
    require_parity(facet_queries());
}

fn filtered_queries() -> Vec<(Value, usize)> {
    vec![
        step(
            r#"{"term": "tax", "sort": {"year": "desc"}, "limit": 7, "filters": {"fields": {"chamber": {"eq": "house"}}}}"#,
            3,
        ),
        step(
            r#"{"term": "tax", "sort": {"code": "asc"}, "facets": {"chamber": {}, "topics": {}}, "limit": 5, "filters": {"fields": {"year": {"lt": 1990}}}}"#,
            2,
        ),
        step(
            r#"{"term": "tax", "facets": {"chamber": {}, "topics": {}, "year": {"ranges": [{"from": 1970, "to": 2000}]}}, "filters": {"fields": {"year": {"gte": 2000}}}}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "facets": {"chamber": {}}, "minScore": 4, "filters": {"fields": {"enacted": {"eq": false}}}}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "group": {"fields": ["chamber"], "maxPerGroup": 2, "reduce": "scoreSum"}, "filters": {"fields": {"enacted": {"eq": true}}}}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "limit": 4, "pinned": [{"docId": "train-00000", "position": 0}, {"docId": "train-00001", "position": 2}], "filters": {"fields": {"chamber": {"eq": "senate"}}}}"#,
            2,
        ),
        step(
            r#"{"term": "tax", "limit": 5, "filters": {"fields": {"topics": {"eq": "health"}}}}"#,
            3,
        ),
        step(
            r#"{"term": "", "sort": {"year": "asc"}, "limit": 5, "filters": {"fields": {"chamber": {"eq": "joint"}}}}"#,
            2,
        ),
        step(
            r#"{"term": "tax", "facets": {"chamber": {}}, "sort": {"year": "asc"}, "filters": {"fields": {"chamber": {"eq": "nothing"}}}}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "limit": 3, "filters": {"fields": {"chamber": {"eq": "house"}}}, "$next": {"filters": {"fields": {"chamber": {"eq": "senate"}}}}}"#,
            2,
        ),
        step(
            r#"{"term": "tax", "sort": {"year": "asc"}, "limit": 3, "filters": {"fields": {"chamber": {"eq": "house"}}}, "$next": {"filters": {"fields": {"chamber": {"eq": "senate"}}}}}"#,
            2,
        ),
    ]
}

#[test]
fn filtered_queries_shape_only_the_documents_that_the_filter_keeps() {
    require_parity(filtered_queries());
}

fn spread_queries() -> Vec<(Value, usize)> {
    let mut queries = vec![
        step(
            r#"{"term": "tax", "sort": {"year": "desc"}, "limit": 7}"#,
            3,
        ),
        step(
            r#"{"term": "tax", "sort": {"code": "asc"}, "facets": {"chamber": {}}, "limit": 20}"#,
            3,
        ),
        step(r#"{"term": "tax", "limit": 5}"#, 3),
        step(
            r#"{"term": "tax", "limit": 6, "pinned": [{"docId": "train-00000", "position": 0}, {"docId": "train-00002-1", "position": 3}]}"#,
            2,
        ),
        step(
            r#"{"term": "tax", "group": {"fields": ["chamber", "enacted"], "maxPerGroup": 3, "reduce": "yearList"}}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "facets": {"chamber": {}, "topics": {}, "code": {}, "year": {"ranges": [{"from": 1970, "to": 1990}]}}}"#,
            1,
        ),
        step(
            r#"{"term": "", "facets": {"chamber": {}}, "sort": {"year": "asc"}, "limit": 4}"#,
            2,
        ),
        step(
            r#"{"term": "tax", "facets": {"chamber": {}}, "termMatch": "all", "minScore": 3}"#,
            1,
        ),
        step(
            r#"{"term": "tax", "highlight": {"fields": ["title"]}, "group": {"fields": ["chamber"]}, "limit": 4}"#,
            2,
        ),
    ];
    queries.extend(filtered_queries());
    queries
}

#[test]
fn queries_spread_across_partitions_shape_exactly_as_the_reference_does() {
    require_spread_parity(spread_queries());
}

use unicode_normalization::UnicodeNormalization;

use narsil::{HighlightConfig, IndexConfig, Map, Narsil, QueryParams, Value, parse_json};

const FIRST_COMBINING_MARK: char = '\u{0300}';
const LAST_COMBINING_MARK: char = '\u{036f}';
const LCG_MULTIPLIER: u64 = 1_103_515_245;
const LCG_INCREMENT: u64 = 12_345;
const LCG_MODULUS: u64 = 1 << 31;
const LCG_LOW_BITS: u64 = 1 << 16;
pub const EVERY_HIT: usize = 1_000;

pub const HAUSA_HOOKED_LETTERS: [(char, char); 4] =
    [('ɓ', 'b'), ('ɗ', 'd'), ('ƙ', 'k'), ('ƴ', 'y')];

pub const YORUBA_WORDS: [&str; 24] = [
    "ọkọ",
    "ọkọ̀",
    "oko",
    "okò",
    "ilé",
    "ile",
    "ìlú",
    "ilu",
    "ọmọ",
    "omo",
    "ẹja",
    "eja",
    "ọjà",
    "oja",
    "àgbà",
    "agba",
    "ṣẹ́gun",
    "segun",
    "kékeré",
    "kekere",
    "ọ̀rẹ́",
    "ore",
    "ìwé",
    "iwe",
];

pub const YORUBA_QUERY_WORDS: [&str; 11] = [
    "oko", "ile", "ilu", "omo", "eja", "oja", "agba", "segun", "kekere", "ore", "iwe",
];

pub struct WordDocument {
    pub id: String,
    pub body: String,
}

pub fn fold_oracle(word: &str, letters: &[(char, char)]) -> String {
    word.nfd()
        .filter(|point| !(FIRST_COMBINING_MARK..=LAST_COMBINING_MARK).contains(point))
        .map(|point| {
            letters
                .iter()
                .find(|(from, _)| *from == point)
                .map_or(point, |(_, to)| *to)
        })
        .collect()
}

pub fn yoruba_fold(word: &str) -> String {
    fold_oracle(word, &[])
}

pub fn edit_distance(left: &str, right: &str) -> usize {
    let a: Vec<char> = left.chars().collect();
    let b: Vec<char> = right.chars().collect();
    let mut previous: Vec<usize> = (0..=b.len()).collect();
    for row in 1..=a.len() {
        let mut current = vec![row];
        for column in 1..=b.len() {
            let substitution = previous[column - 1] + usize::from(a[row - 1] != b[column - 1]);
            current.push(
                (previous[column] + 1)
                    .min(current[column - 1] + 1)
                    .min(substitution),
            );
        }
        previous = current;
    }
    previous[b.len()]
}

pub fn shares_leading_points(candidate: &str, query: &str, count: usize) -> bool {
    let kept: Vec<char> = query.chars().take(count).collect();
    let leading: Vec<char> = candidate.chars().take(kept.len()).collect();
    leading == kept
}

pub fn ids_with_word(documents: &[WordDocument], matches: impl Fn(&str) -> bool) -> Vec<String> {
    let mut ids: Vec<String> = documents
        .iter()
        .filter(|document| document.body.split(' ').any(&matches))
        .map(|document| document.id.clone())
        .collect();
    ids.sort();
    ids
}

pub fn generated_documents(count: usize, words: &[&str], seed: u64) -> Vec<WordDocument> {
    let mut state = seed;
    let mut next = || {
        state = (state * LCG_MULTIPLIER + LCG_INCREMENT) % LCG_MODULUS;
        (state / LCG_LOW_BITS) as usize
    };
    (0..count)
        .map(|at| {
            let length = 2 + next() % 3;
            let body: Vec<&str> = (0..length).map(|_| words[next() % words.len()]).collect();
            WordDocument {
                id: format!("doc-{at:05}"),
                body: body.join(" "),
            }
        })
        .collect()
}

pub fn word_spans(text: &str, matches: impl Fn(&str) -> bool) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut start = 0;
    for word in text.split(' ') {
        let length = word.encode_utf16().count();
        if matches(word) {
            spans.push((start, start + length));
        }
        start += length + 1;
    }
    spans
}

pub fn text_index(language: &str, schema: &str) -> IndexConfig {
    IndexConfig {
        schema: parse_json(schema).expect("the schema is JSON"),
        language: Some(language.to_string()),
        ..IndexConfig::default()
    }
}

pub fn document_maps(documents: &[WordDocument]) -> Vec<Map> {
    documents
        .iter()
        .map(|document| {
            let mut map = Map::new();
            map.insert("id", Value::String(document.id.clone()));
            map.insert("body", Value::String(document.body.clone()));
            map
        })
        .collect()
}

pub fn insert_all(narsil: &Narsil, index: &str, documents: &[WordDocument]) {
    let written = narsil
        .insert_batch(index, document_maps(documents))
        .expect("the batch is written");
    assert!(written.failed.is_empty(), "the batch refused documents");
}

pub fn term_query(term: &str) -> QueryParams {
    QueryParams {
        term: Some(term.to_string()),
        limit: Some(EVERY_HIT),
        ..QueryParams::default()
    }
}

pub fn hit_ids(narsil: &Narsil, index: &str, params: &QueryParams) -> Vec<String> {
    let mut ids = ranked_ids(narsil, index, params);
    ids.sort();
    ids
}

pub fn ranked_ids(narsil: &Narsil, index: &str, params: &QueryParams) -> Vec<String> {
    narsil
        .query(index, params)
        .expect("the search answers")
        .hits
        .into_iter()
        .map(|hit| hit.id)
        .collect()
}

pub fn highlight_spans(
    narsil: &Narsil,
    index: &str,
    params: QueryParams,
    id: &str,
    field: &str,
) -> Option<Vec<(usize, usize)>> {
    let params = QueryParams {
        highlight: Some(HighlightConfig {
            fields: vec![field.to_string()],
            ..HighlightConfig::default()
        }),
        ..params
    };
    let result = narsil.query(index, &params).expect("the search answers");
    let hit = result.hits.into_iter().find(|hit| hit.id == id)?;
    let (_, found) = hit
        .highlights?
        .into_iter()
        .find(|(name, _)| name == field)?;
    Some(
        found
            .positions
            .iter()
            .map(|position| (position.start, position.end))
            .collect(),
    )
}

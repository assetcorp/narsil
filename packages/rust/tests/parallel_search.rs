mod support;

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;

use narsil::{
    DurabilityConfig, DurabilityMode, ErrorCode, IndexConfig, MainCopyQueries, Map, Narsil,
    NarsilConfig, PartitionConfig, QueryParams, QueryResult, TermMatch, Value, WorkerConfig,
    parse_json,
};
use support::ScratchDirectory;

const INDEX: &str = "notes";
const PARTITIONS: u64 = 4;
const INITIAL_DOCUMENTS: usize = 21_000;
const VOCABULARY: usize = 160;
const WORDS_PER_DOCUMENT: usize = 6;
const SEARCH_THREADS: usize = 4;
const SEARCHES_PER_THREAD: usize = 30;
const WRITES_PER_ROUND: usize = 300;
const INSERT_BATCH: usize = 1_000;
const PAGE_LIMIT: usize = 5_000;
const LETTERS: &[u8] = b"bcdfghjkmnpqrtvwxz";
const IN_FLIGHT: u64 = u64::MAX;

struct Random(u64);

impl Random {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, bound: usize) -> usize {
        (self.next() % bound as u64) as usize
    }
}

fn word(number: usize) -> String {
    let base = LETTERS.len();
    [number / (base * base), number / base, number]
        .iter()
        .map(|digit| LETTERS[digit % base] as char)
        .collect()
}

fn body(random: &mut Random) -> String {
    (0..WORDS_PER_DOCUMENT)
        .map(|_| word(random.below(VOCABULARY)))
        .collect::<Vec<_>>()
        .join(" ")
}

fn document(id: &str, text: &str) -> Map {
    let mut document = Map::new();
    document.insert("id", Value::String(id.to_string()));
    document.insert("body", Value::String(text.to_string()));
    document
}

#[derive(Clone, Default)]
struct Live {
    documents: BTreeMap<String, String>,
    changed_at: BTreeMap<String, u64>,
    version: u64,
}

impl Live {
    fn begin(&mut self, id: &str) {
        self.version += 1;
        self.changed_at.insert(id.to_string(), IN_FLIGHT);
    }

    fn record(&mut self, id: &str, text: Option<String>) {
        self.version += 1;
        self.changed_at.insert(id.to_string(), self.version);
        match text {
            Some(text) => self.documents.insert(id.to_string(), text),
            None => self.documents.remove(id),
        };
    }

    fn changed_after(&self, version: u64) -> BTreeSet<String> {
        self.changed_at
            .iter()
            .filter(|(_, changed)| **changed > version)
            .map(|(id, _)| id.clone())
            .collect()
    }
}

fn matching(documents: &BTreeMap<String, String>, words: &[String]) -> BTreeSet<String> {
    documents
        .iter()
        .filter(|(_, text)| text.split(' ').any(|held| words.iter().any(|w| w == held)))
        .map(|(id, _)| id.clone())
        .collect()
}

fn config(root: &Path) -> NarsilConfig {
    NarsilConfig {
        durability: Some(DurabilityConfig {
            directory: Some(root.to_path_buf()),
            mode: Some(DurabilityMode::Sync),
            ..DurabilityConfig::default()
        }),
        ..NarsilConfig::default()
    }
}

fn index_config() -> IndexConfig {
    IndexConfig {
        schema: parse_json(r#"{"body": "string"}"#).expect("the schema is JSON"),
        language: Some("english".into()),
        partitions: Some(PartitionConfig {
            max_partitions: Some(PARTITIONS),
            max_docs_per_partition: Some(1_000_000),
            ..PartitionConfig::default()
        }),
        ..IndexConfig::default()
    }
}

fn search(engine: &Narsil, words: &[String]) -> QueryResult {
    let params = QueryParams {
        term: Some(words.join(" ")),
        term_match: Some(TermMatch::Any),
        limit: Some(PAGE_LIMIT),
        ..QueryParams::default()
    };
    engine.query(INDEX, &params).expect("the query answers")
}

fn found_ids(result: &QueryResult) -> BTreeSet<String> {
    let found: BTreeSet<String> = result.hits.iter().map(|hit| hit.id.clone()).collect();
    assert_eq!(found.len(), result.hits.len(), "a hit came back twice");
    found
}

fn body_of(document: &Map) -> Option<&str> {
    document.get("body").and_then(Value::as_str)
}

fn require_exact(engine: &Narsil, live: &Live, words: &[String]) {
    let result = search(engine, words);
    let wanted = matching(&live.documents, words);
    assert_eq!(found_ids(&result), wanted, "the hits of {words:?}");
    assert_eq!(result.count, wanted.len() as u64, "the count of {words:?}");
    assert!(result.count_exact);
    for hit in &result.hits {
        assert_eq!(
            body_of(&hit.document),
            live.documents.get(&hit.id).map(String::as_str)
        );
    }
}

fn require_every_word(engine: &Narsil, live: &Live) {
    for number in 0..VOCABULARY {
        require_exact(engine, live, &[word(number)]);
    }
    require_exact(engine, live, &[word(3), word(VOCABULARY - 1)]);
}

fn require_within_window(before: &Live, after: &Live, words: &[String], result: &QueryResult) {
    let moving = after.changed_after(before.version);
    let found = found_ids(result);
    let required: BTreeSet<String> = matching(&after.documents, words)
        .into_iter()
        .filter(|id| !moving.contains(id))
        .collect();
    let mut allowed = matching(&before.documents, words);
    allowed.extend(matching(&after.documents, words));
    allowed.extend(moving.iter().cloned());
    assert!(
        required.is_subset(&found),
        "{words:?} lost {:?}",
        required.difference(&found).collect::<Vec<_>>()
    );
    assert!(
        found.is_subset(&allowed),
        "{words:?} returned {:?}",
        found.difference(&allowed).collect::<Vec<_>>()
    );
    assert!(required.len() as u64 <= result.count && result.count <= allowed.len() as u64);
    for hit in &result.hits {
        if moving.contains(&hit.id) {
            continue;
        }
        assert_eq!(
            body_of(&hit.document),
            after.documents.get(&hit.id).map(String::as_str)
        );
    }
}

fn searcher(engine: &Narsil, live: &Mutex<Arc<Live>>, seed: u64) {
    let mut random = Random(seed);
    for _ in 0..SEARCHES_PER_THREAD {
        let mut words = vec![word(random.below(VOCABULARY))];
        if random.below(2) == 0 {
            words.push(word(random.below(VOCABULARY)));
        }
        let before = Arc::clone(&live.lock().expect("the oracle lock"));
        let result = search(engine, &words);
        let after = Arc::clone(&live.lock().expect("the oracle lock"));
        require_within_window(&before, &after, &words, &result);
    }
}

struct Writer {
    random: Random,
    ids: Vec<String>,
    next_id: usize,
}

fn change(live: &Mutex<Arc<Live>>, apply: impl FnOnce(&mut Live)) {
    apply(Arc::make_mut(&mut live.lock().expect("the oracle lock")));
}

impl Writer {
    fn write_one(&mut self, engine: &Narsil, live: &Mutex<Arc<Live>>) {
        let choice = self.random.below(3);
        if choice == 0 || self.ids.is_empty() {
            let id = format!("n{:06}", self.next_id);
            self.next_id += 1;
            let text = body(&mut self.random);
            change(live, |held| held.begin(&id));
            engine
                .insert(INDEX, document(&id, &text), None)
                .expect("the insert applies");
            self.ids.push(id.clone());
            change(live, |held| held.record(&id, Some(text)));
            return;
        }
        let at = self.random.below(self.ids.len());
        let id = self.ids[at].clone();
        change(live, |held| held.begin(&id));
        if choice == 1 {
            let text = body(&mut self.random);
            engine
                .update(INDEX, &id, document(&id, &text))
                .expect("the update applies");
            change(live, |held| held.record(&id, Some(text)));
            return;
        }
        engine.remove(INDEX, &id).expect("the removal applies");
        self.ids.swap_remove(at);
        change(live, |held| held.record(&id, None));
    }
}

fn concurrent_round(
    engine: &Narsil,
    live: &Mutex<Arc<Live>>,
    writer: &mut Writer,
    seed: u64,
    finish: impl FnOnce(&Narsil, &Mutex<Arc<Live>>) + Send,
) {
    thread::scope(|scope| {
        let searchers: Vec<_> = (0..SEARCH_THREADS)
            .map(|at| scope.spawn(move || searcher(engine, live, seed + at as u64 * 7_919)))
            .collect();
        for _ in 0..WRITES_PER_ROUND {
            writer.write_one(engine, live);
        }
        finish(engine, live);
        for handle in searchers {
            handle.join().expect("a search thread finished");
        }
    });
}

fn current(live: &Mutex<Arc<Live>>) -> Arc<Live> {
    Arc::clone(&live.lock().expect("the oracle lock"))
}

fn restored(snapshot: &Live, now: &Live) -> Live {
    let mut back = Live {
        documents: snapshot.documents.clone(),
        changed_at: now.changed_at.clone(),
        version: now.version + 1,
    };
    let touched: BTreeSet<String> = snapshot
        .documents
        .keys()
        .chain(now.documents.keys())
        .cloned()
        .collect();
    for id in touched {
        back.changed_at.insert(id, back.version);
    }
    back
}

#[test]
fn worker_settings_that_typescript_refuses_fail_to_open() {
    let refused = [
        WorkerConfig {
            count: Some(0),
            ..WorkerConfig::default()
        },
        WorkerConfig {
            promotion_threshold: Some(0),
            ..WorkerConfig::default()
        },
        WorkerConfig {
            idle_timeout_ms: Some(9_007_199_254_740_992),
            ..WorkerConfig::default()
        },
    ];
    for workers in refused {
        let opened = Narsil::open(NarsilConfig {
            workers: Some(workers.clone()),
            ..NarsilConfig::default()
        });
        let error = opened.err().expect("the setting is refused");
        assert_eq!(error.code(), ErrorCode::CONFIG_INVALID, "{workers:?}");
    }
    let engine = Narsil::open(NarsilConfig {
        workers: Some(WorkerConfig {
            enabled: Some(true),
            count: Some(64),
            promotion_threshold: Some(9_007_199_254_740_991),
            idle_timeout_ms: Some(1),
            main_copy_queries: Some(MainCopyQueries::None),
        }),
        ..NarsilConfig::default()
    })
    .expect("TypeScript accepts these settings");
    let missing = engine.wait_for_writes("absent").expect_err("no such index");
    assert_eq!(missing.code(), ErrorCode::INDEX_NOT_FOUND);
}

#[test]
fn searches_from_several_threads_see_every_acknowledged_write() {
    let root = ScratchDirectory::new("parallel-search");
    let mut random = Random(0x9e37_79b9_7f4a_7c15);
    let mut live = Live::default();
    let mut engine = Narsil::open(config(root.path())).expect("the engine opens");
    engine
        .create_index(INDEX, index_config())
        .expect("the index is created");
    let mut writer = Writer {
        random: Random(0x2545_f491_4f6c_dd1d),
        ids: Vec::new(),
        next_id: INITIAL_DOCUMENTS,
    };
    let initial: Vec<(String, String)> = (0..INITIAL_DOCUMENTS)
        .map(|at| (format!("d{at:06}"), body(&mut random)))
        .collect();
    for batch in initial.chunks(INSERT_BATCH) {
        let documents = batch.iter().map(|(id, text)| document(id, text)).collect();
        let result = engine
            .insert_batch(INDEX, documents)
            .expect("the batch applies");
        assert!(result.failed.is_empty());
        for (id, text) in batch {
            live.record(id, Some(text.clone()));
            writer.ids.push(id.clone());
        }
    }
    let live = Mutex::new(Arc::new(live));
    require_every_word(&engine, &current(&live));

    concurrent_round(&engine, &live, &mut writer, 11, |_, _| {});
    require_every_word(&engine, &current(&live));

    engine.shutdown().expect("the engine shuts down");
    engine = Narsil::open(config(root.path())).expect("the engine reopens");
    require_every_word(&engine, &current(&live));

    let mut snapshot = Vec::new();
    engine
        .snapshot(INDEX, &mut snapshot)
        .expect("the snapshot is taken");
    let saved = current(&live);
    concurrent_round(&engine, &live, &mut writer, 23, |engine, live| {
        change(live, |held| {
            let touched: Vec<String> = saved
                .documents
                .keys()
                .chain(held.documents.keys())
                .cloned()
                .collect();
            for id in touched {
                held.begin(&id);
            }
        });
        engine
            .restore(INDEX, &mut snapshot.as_slice())
            .expect("the snapshot restores");
        let mut held = live.lock().expect("the oracle lock");
        let back = restored(&saved, &held);
        *held = Arc::new(back);
    });
    writer.ids = current(&live).documents.keys().cloned().collect();
    require_every_word(&engine, &current(&live));

    concurrent_round(&engine, &live, &mut writer, 37, |_, _| {});
    engine.shutdown().expect("the engine shuts down");
    let engine = Narsil::open(config(root.path())).expect("the engine reopens");
    require_every_word(&engine, &current(&live));
    engine.shutdown().expect("the engine shuts down");
}

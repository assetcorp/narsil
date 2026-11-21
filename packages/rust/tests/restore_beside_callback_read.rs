mod support;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, OnceLock, Weak};
use std::time::{Duration, Instant};

use narsil::{
    DurabilityConfig, IndexConfig, Map, Narsil, NarsilConfig, QueryParams, Storage, Token,
    Tokenizer, TokenizerSetting, VectorPromotion, parse_json,
};

const INDEX: &str = "articles";
const DOC_ID: &str = "article";
const ANSWER_WAIT: Duration = Duration::from_secs(10);
const NESTED_READ_WINDOW: Duration = Duration::from_millis(500);

struct ReadsDuringSearch {
    found: Vec<Option<Map>>,
    listed: Vec<Vec<String>>,
}

struct ReadingTokenizer {
    armed: AtomicBool,
    engine: OnceLock<Weak<Narsil>>,
    entered: Sender<()>,
    reads: Sender<ReadsDuringSearch>,
}

impl Tokenizer for ReadingTokenizer {
    fn tokenize(&self, text: &str) -> Vec<Token> {
        if self.armed.swap(false, Ordering::SeqCst) {
            let engine = self.engine.get().and_then(Weak::upgrade).unwrap();
            self.entered.send(()).unwrap();
            let mut reads = ReadsDuringSearch {
                found: Vec::new(),
                listed: Vec::new(),
            };
            let started = Instant::now();
            while started.elapsed() < NESTED_READ_WINDOW {
                reads.found.push(
                    engine
                        .get_with(INDEX, DOC_ID, Some(&support::WHOLE_DOCUMENT))
                        .unwrap(),
                );
                reads.listed.push(
                    engine
                        .list_indexes()
                        .into_iter()
                        .map(|info| info.name)
                        .collect(),
                );
            }
            self.reads.send(reads).unwrap();
        }
        vec![Token {
            token: text.to_string(),
            position: 0,
        }]
    }
}

fn durability(scratch: &support::ScratchDirectory) -> Option<DurabilityConfig> {
    Some(DurabilityConfig {
        directory: Some(scratch.path().to_path_buf()),
        ..DurabilityConfig::default()
    })
}

#[test]
fn a_tokenizer_reading_its_own_index_during_a_restore_swap_finishes_both_calls() {
    let scratch = support::ScratchDirectory::new("restore-callback-read");
    let (entered, waiting) = channel();
    let (reads, read) = channel();
    let tokenizer = Arc::new(ReadingTokenizer {
        armed: AtomicBool::new(false),
        engine: OnceLock::new(),
        entered,
        reads,
    });
    let engine = Arc::new(
        Narsil::open(NarsilConfig {
            durability: durability(&scratch),
            ..NarsilConfig::default()
        })
        .unwrap(),
    );
    tokenizer.engine.set(Arc::downgrade(&engine)).unwrap();
    engine
        .register_tokenizer("reading", tokenizer.clone())
        .unwrap();
    engine
        .create_index(
            INDEX,
            IndexConfig {
                schema: parse_json(r#"{"title":"string","embedding":"vector[2]"}"#).unwrap(),
                tokenizer: Some(TokenizerSetting::Named("reading".to_string())),
                text_storage: Some(Storage::Disk),
                vector_promotion: Some(VectorPromotion {
                    threshold: Some(1),
                    storage: Some(Storage::Disk),
                    ..VectorPromotion::default()
                }),
                ..IndexConfig::default()
            },
        )
        .unwrap();
    let expected = parse_json(r#"{"title":"article","embedding":[1,0]}"#)
        .unwrap()
        .as_object()
        .unwrap()
        .clone();
    engine
        .insert(INDEX, expected.clone(), Some(DOC_ID))
        .unwrap();
    engine.optimize_vectors(INDEX, None).unwrap();
    engine.checkpoint(INDEX).unwrap();
    let mut snapshot = Vec::new();
    engine.snapshot(INDEX, &mut snapshot).unwrap();
    tokenizer.armed.store(true, Ordering::SeqCst);
    let (searched, search_answer) = channel();
    let searching = Arc::clone(&engine);
    std::thread::spawn(move || {
        let result = searching.query(
            INDEX,
            &QueryParams {
                document: Some(support::WHOLE_DOCUMENT),
                term: Some("article".to_string()),
                ..QueryParams::default()
            },
        );
        searched.send(result).unwrap();
    });
    waiting.recv_timeout(ANSWER_WAIT).unwrap();
    let (restored, restore_answer) = channel();
    let restoring = Arc::clone(&engine);
    std::thread::spawn(move || {
        restored
            .send(restoring.restore(INDEX, &mut snapshot.as_slice()))
            .unwrap();
    });
    let reads = read
        .recv_timeout(ANSWER_WAIT)
        .expect("the reads inside the search finish while the restore waits for that search");
    let result = search_answer.recv_timeout(ANSWER_WAIT).unwrap().unwrap();
    restore_answer.recv_timeout(ANSWER_WAIT).unwrap().unwrap();
    assert!(!reads.found.is_empty());
    assert!(
        reads
            .found
            .iter()
            .all(|found| found.as_ref() == Some(&expected))
    );
    assert!(reads.listed.iter().all(|names| names == &[INDEX]));
    assert_eq!(result.hits.len(), 1);
    assert_eq!(result.hits[0].document, expected);
    assert_eq!(
        engine
            .get_with(INDEX, DOC_ID, Some(&support::WHOLE_DOCUMENT))
            .unwrap(),
        Some(expected)
    );
    engine.shutdown().unwrap();
}

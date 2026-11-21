mod support;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use narsil::{
    DurabilityConfig, GroupConfig, GroupReducer, IndexConfig, Narsil, NarsilConfig, QueryParams,
    Storage, Token, Tokenizer, TokenizerSetting, Value, VectorPromotion, parse_json,
};

const ANSWER_WAIT: Duration = Duration::from_secs(10);
const DRAIN_WAIT: Duration = Duration::from_secs(1);

struct HeldTokenizer {
    armed: AtomicBool,
    entered: Sender<()>,
    release: Mutex<Receiver<()>>,
}

#[test]
fn shutdown_inside_a_group_reducer_is_refused_without_stopping_the_engine() {
    let engine = Arc::new(Narsil::new());
    engine
        .create_index(
            "articles",
            IndexConfig {
                schema: parse_json(r#"{"title":"string","embedding":"vector[2]"}"#).unwrap(),
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
        .insert("articles", expected.clone(), Some("article"))
        .unwrap();
    let (answer, answered) = channel();
    let calling = Arc::clone(&engine);
    std::thread::spawn(move || {
        let stopping = Arc::clone(&calling);
        let (shutdown, shut_down) = channel();
        let params = QueryParams {
            document: Some(support::WHOLE_DOCUMENT),
            term: Some("article".to_string()),
            group: Some(GroupConfig {
                fields: vec!["title".to_string()],
                reduce: Some(GroupReducer {
                    initial_value: Arc::new(move || {
                        shutdown.send(stopping.shutdown()).unwrap();
                        Value::Null
                    }),
                    reducer: Arc::new(|value, _, _| Ok(value)),
                }),
                ..GroupConfig::default()
            }),
            ..QueryParams::default()
        };
        let result = calling.query("articles", &params);
        answer.send((result, shut_down.try_recv())).unwrap();
    });
    let (result, shutdown) = answered.recv_timeout(ANSWER_WAIT).unwrap();
    assert_eq!(
        shutdown.unwrap().unwrap_err().code(),
        narsil::ErrorCode::CONFIG_INVALID
    );
    assert_eq!(result.unwrap().hits[0].document, expected);
    assert_eq!(
        engine
            .get_with("articles", "article", Some(&support::WHOLE_DOCUMENT))
            .unwrap(),
        Some(expected)
    );
    engine.shutdown().unwrap();
}

impl Tokenizer for HeldTokenizer {
    fn tokenize(&self, text: &str) -> Vec<Token> {
        if self.armed.swap(false, Ordering::SeqCst) {
            self.entered.send(()).unwrap();
            self.release
                .lock()
                .unwrap()
                .recv_timeout(ANSWER_WAIT)
                .unwrap();
        }
        vec![Token {
            token: text.to_string(),
            position: 0,
        }]
    }
}

fn shutdown_beside_read(disk: bool) {
    let scratch = support::ScratchDirectory::new("shutdown-vector-read");
    let (entered, waiting) = channel();
    let (release, released) = channel();
    let tokenizer = Arc::new(HeldTokenizer {
        armed: AtomicBool::new(false),
        entered,
        release: Mutex::new(released),
    });
    let engine = Narsil::open(NarsilConfig {
        durability: disk.then(|| DurabilityConfig {
            directory: Some(scratch.path().to_path_buf()),
            ..DurabilityConfig::default()
        }),
        ..NarsilConfig::default()
    })
    .unwrap();
    engine
        .register_tokenizer("held", tokenizer.clone())
        .unwrap();
    engine
        .create_index(
            "articles",
            IndexConfig {
                schema: parse_json(r#"{"title":"string","embedding":"vector[2]"}"#).unwrap(),
                tokenizer: Some(TokenizerSetting::Named("held".to_string())),
                text_storage: disk.then_some(Storage::Disk),
                vector_promotion: disk.then(|| VectorPromotion {
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
        .insert("articles", expected.clone(), Some("article"))
        .unwrap();
    if disk {
        engine.optimize_vectors("articles", None).unwrap();
        engine.checkpoint("articles").unwrap();
    }
    tokenizer.armed.store(true, Ordering::SeqCst);
    std::thread::scope(|scope| {
        let search = scope.spawn(|| {
            engine.query(
                "articles",
                &QueryParams {
                    document: Some(support::WHOLE_DOCUMENT),
                    term: Some("article".to_string()),
                    ..QueryParams::default()
                },
            )
        });
        waiting.recv_timeout(ANSWER_WAIT).unwrap();
        let (finished, stopped) = channel();
        let stopping = &engine;
        let shutdown = scope.spawn(move || {
            let result = stopping.shutdown();
            finished.send(()).unwrap();
            result
        });
        let deadline = Instant::now() + ANSWER_WAIT;
        while !engine.list_indexes().is_empty() {
            assert!(Instant::now() < deadline, "shutdown never took the index");
            std::thread::yield_now();
        }
        let returned_before_read = stopped.recv_timeout(DRAIN_WAIT).is_ok();
        release.send(()).unwrap();
        let result = search.join().unwrap();
        shutdown.join().unwrap().unwrap();
        match result {
            Ok(result) => {
                assert_eq!(result.hits.len(), 1);
                assert_eq!(result.hits[0].document, expected);
            }
            Err(error) => assert_eq!(error.code(), narsil::ErrorCode::INSTANCE_SHUT_DOWN),
        }
        assert!(
            !returned_before_read,
            "shutdown returned while the search held the index"
        );
    });
    if disk {
        let reopened = Narsil::open_with(
            NarsilConfig {
                durability: Some(DurabilityConfig {
                    directory: Some(scratch.path().to_path_buf()),
                    ..DurabilityConfig::default()
                }),
                ..NarsilConfig::default()
            },
            |engine| engine.register_tokenizer("held", tokenizer),
        )
        .unwrap();
        assert_eq!(
            reopened
                .get_with("articles", "article", Some(&support::WHOLE_DOCUMENT))
                .unwrap(),
            Some(expected)
        );
        reopened.shutdown().unwrap();
        std::fs::remove_dir_all(scratch.path()).unwrap();
    }
}
#[test]
fn shutdown_keeps_memory_vectors_until_an_admitted_search_finishes() {
    shutdown_beside_read(false);
}

#[test]
fn shutdown_keeps_disk_vectors_until_an_admitted_search_finishes_and_reopens() {
    shutdown_beside_read(true);
}

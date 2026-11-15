mod support;

use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use narsil::{
    DurabilityConfig, ErrorCode, GroupConfig, GroupReducer, IndexConfig, Narsil, NarsilConfig,
    QueryParams, Storage, Value, VectorPromotion, parse_json,
};

const INDEX: &str = "articles";
const ANSWER_WAIT: Duration = Duration::from_secs(10);
const QUEUED_WAIT: Duration = Duration::from_millis(200);

fn answered<T: Send + 'static>(call: impl FnOnce() -> T + Send + 'static) -> Receiver<T> {
    let (answer, answers) = channel();
    std::thread::spawn(move || {
        let _ = answer.send(call());
    });
    answers
}

fn configuration(scratch: &support::ScratchDirectory) -> NarsilConfig {
    NarsilConfig {
        durability: Some(DurabilityConfig {
            directory: Some(scratch.path().to_path_buf()),
            ..DurabilityConfig::default()
        }),
        ..NarsilConfig::default()
    }
}

#[test]
fn shutdown_wakes_reads_already_waiting_for_a_restore_to_drain_a_search() {
    let scratch = support::ScratchDirectory::new("shutdown-restore-read");
    let engine = Arc::new(Narsil::open(configuration(&scratch)).unwrap());
    engine
        .create_index(
            INDEX,
            IndexConfig {
                schema: parse_json(r#"{"title":"string","embedding":"vector[2]"}"#).unwrap(),
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
        .insert(INDEX, expected.clone(), Some("kept"))
        .unwrap();
    engine.optimize_vectors(INDEX, None).unwrap();
    engine.checkpoint(INDEX).unwrap();
    let mut snapshot = Vec::new();
    engine.snapshot(INDEX, &mut snapshot).unwrap();

    let (entered, searching) = channel();
    let (release, released) = channel();
    let released = Mutex::new(released);
    let query_engine = Arc::clone(&engine);
    let search = answered(move || {
        query_engine.query(
            INDEX,
            &QueryParams {
                term: Some("article".to_string()),
                group: Some(GroupConfig {
                    fields: vec!["title".to_string()],
                    reduce: Some(GroupReducer {
                        initial_value: Arc::new(move || {
                            entered.send(()).unwrap();
                            released.lock().unwrap().recv().unwrap();
                            Value::Null
                        }),
                        reducer: Arc::new(|value, _, _| Ok(value)),
                    }),
                    ..GroupConfig::default()
                }),
                ..QueryParams::default()
            },
        )
    });
    searching.recv_timeout(ANSWER_WAIT).unwrap();
    let restoring = Arc::clone(&engine);
    let restored = answered(move || restoring.restore(INDEX, &mut snapshot.as_slice()));
    let deadline = Instant::now() + ANSWER_WAIT;
    while !std::fs::read_dir(scratch.path()).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".swap-")
    }) {
        assert!(
            Instant::now() < deadline,
            "the restore did not commit its journal"
        );
        std::thread::yield_now();
    }

    let (started, waiting) = channel();
    let (answer, answers) = channel();
    let readers: Vec<_> = (0..3)
        .map(|operation| {
            let engine = Arc::clone(&engine);
            let started = started.clone();
            let answer = answer.clone();
            std::thread::spawn(move || {
                started.send(()).unwrap();
                loop {
                    let result = match operation {
                        0 => engine.get(INDEX, "kept").map(|_| false),
                        1 => engine
                            .query(
                                INDEX,
                                &QueryParams {
                                    term: Some("article".to_string()),
                                    ..QueryParams::default()
                                },
                            )
                            .map(|_| false),
                        _ => Ok(engine.list_indexes().is_empty()),
                    };
                    let finished = !matches!(result, Ok(false));
                    answer.send((operation, result)).unwrap();
                    if finished {
                        break;
                    }
                    std::thread::yield_now();
                }
            })
        })
        .collect();
    for _ in &readers {
        waiting.recv_timeout(ANSWER_WAIT).unwrap();
    }
    let deadline = Instant::now() + ANSWER_WAIT;
    while let Ok((_, result)) = answers.recv_timeout(QUEUED_WAIT) {
        assert!(!result.unwrap(), "the index disappeared before shutdown");
        assert!(
            Instant::now() < deadline,
            "the reads did not wait for the restore"
        );
    }
    let stopping = Arc::clone(&engine);
    let stopped = answered(move || stopping.shutdown());
    let deadline = Instant::now() + ANSWER_WAIT;
    while engine.open_index(INDEX).is_ok() {
        assert!(Instant::now() < deadline, "shutdown did not stop admission");
        std::thread::yield_now();
    }
    let mut awakened = Vec::new();
    while awakened.len() < readers.len() {
        match answers.recv_timeout(ANSWER_WAIT) {
            Ok(answer) => awakened.push(answer),
            Err(_) => break,
        }
    }
    release.send(()).unwrap();
    for reader in readers {
        reader.join().unwrap();
    }
    let search = search.recv_timeout(ANSWER_WAIT).unwrap();
    restored.recv_timeout(ANSWER_WAIT).unwrap().unwrap();
    stopped.recv_timeout(ANSWER_WAIT).unwrap().unwrap();
    if let Ok(search) = search {
        assert_eq!(search.hits[0].document, expected);
    } else {
        assert_eq!(search.unwrap_err().code(), ErrorCode::INSTANCE_SHUT_DOWN);
    }
    let reopened = Narsil::open(configuration(&scratch)).unwrap();
    assert_eq!(reopened.get(INDEX, "kept").unwrap(), Some(expected));
    reopened.shutdown().unwrap();
    assert_eq!(
        awakened.len(),
        3,
        "shutdown left reads waiting for the held search"
    );
    for (operation, result) in awakened {
        if operation == 2 {
            assert!(result.unwrap());
        } else {
            assert_eq!(result.unwrap_err().code(), ErrorCode::INSTANCE_SHUT_DOWN);
        }
    }
}

use std::sync::mpsc;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use narsil::{
    AnalysisChange, AnalysisSetting, ErrorCode, IndexConfig, Map, Narsil, NarsilError, NarsilEvent,
    NarsilEventKind, PartitionConfig, Plugin, QueryParams, QueryResult, StopWords,
    StopWordsSetting, Value,
};

const INDEX: &str = "orders";
const LIMIT: Duration = Duration::from_secs(20);

fn index_config(partitions: Option<PartitionConfig>) -> IndexConfig {
    let mut schema = Map::new();
    schema.insert("title", Value::String("string".into()));
    schema.insert("tag", Value::String("string".into()));
    IndexConfig {
        schema: Value::Object(schema),
        partitions,
        ..IndexConfig::default()
    }
}

fn titled(title: &str) -> Map {
    let mut document = Map::new();
    document.insert("title", Value::String(title.into()));
    document
}

fn with_id(id: &str, title: &str) -> Map {
    let mut document = titled(title);
    document.insert("id", Value::String(id.into()));
    document
}

fn search(narsil: &Narsil, term: &str) -> narsil::Result<Vec<String>> {
    let query = QueryParams {
        term: Some(term.into()),
        limit: Some(1_000),
        ..QueryParams::default()
    };
    let mut ids: Vec<String> = narsil
        .query(INDEX, &query)?
        .hits
        .into_iter()
        .map(|hit| hit.id)
        .collect();
    ids.sort();
    Ok(ids)
}

fn within_limit<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(work());
    });
    receiver
        .recv_timeout(LIMIT)
        .expect("the call finished, so no engine lock was held while caller code ran")
}

#[test]
fn a_rebuild_listener_that_calls_the_engine_never_waits_for_its_own_change() {
    let narsil = Arc::new(Narsil::new());
    narsil
        .create_index(INDEX, index_config(None))
        .expect("the index is created");
    for at in 0..50 {
        narsil
            .insert(INDEX, titled("apple pear"), Some(&format!("doc-{at}")))
            .expect("the write succeeds");
    }
    let engine: Weak<Narsil> = Arc::downgrade(&narsil);
    let refusals = Arc::new(Mutex::new(Vec::new()));
    let heard = Arc::clone(&refusals);
    narsil.on(NarsilEventKind::AnalysisRebuild, move |_| {
        let Some(engine) = engine.upgrade() else {
            return;
        };
        let _ = engine.insert(INDEX, titled("pear"), None);
        let _ = search(&engine, "pear");
        let mut log = heard.lock().expect("the log locks");
        if let Err(error) = engine.rebuild_analysis(INDEX) {
            log.push(error.code());
        }
        if let Err(error) = engine.change_analysis(INDEX, &AnalysisChange::default()) {
            log.push(error.code());
        }
    });
    let changer = Arc::clone(&narsil);
    within_limit(move || {
        changer
            .change_analysis(
                INDEX,
                &AnalysisChange {
                    stop_words: AnalysisSetting::Set(StopWordsSetting::Words(StopWords::Set(
                        ["apple".to_string()].into_iter().collect(),
                    ))),
                    ..AnalysisChange::default()
                },
            )
            .expect("the change succeeds");
    });
    assert_eq!(
        search(&narsil, "apple").expect("the search answers"),
        Vec::<String>::new()
    );
    assert_eq!(
        narsil.count_documents(INDEX).expect("the count reads"),
        52,
        "the writes of both listener calls reached the index"
    );
    assert_eq!(
        search(&narsil, "pear").expect("the search answers").len(),
        52,
        "the write during the change reached the new terms"
    );
    assert_eq!(
        *refusals.lock().expect("the log locks"),
        vec![ErrorCode::ANALYSIS_CHANGE_NOT_READY; 2],
        "the started listener's calls are refused, and the completed listener's calls succeed"
    );
}

#[test]
fn listeners_can_call_the_engine_and_a_panicking_listener_breaks_no_write() {
    let narsil = Arc::new(Narsil::new());
    narsil
        .create_index(INDEX, index_config(None))
        .expect("the index is created");
    let counts = Arc::new(Mutex::new(Vec::new()));
    let engine: Weak<Narsil> = Arc::downgrade(&narsil);
    let heard = Arc::clone(&counts);
    let counting = narsil.on(NarsilEventKind::Write, move |event| {
        let (Some(engine), NarsilEvent::Write { index_name }) = (engine.upgrade(), event) else {
            return;
        };
        let count = engine.count_documents(index_name).unwrap_or(u64::MAX);
        let _ = search(&engine, "apple");
        heard.lock().expect("the log locks").push(count);
    });
    let panicking = narsil.on(NarsilEventKind::Write, |_| panic!("a listener panics"));
    let writer = Arc::clone(&narsil);
    within_limit(move || {
        for at in 0..3 {
            writer
                .insert(INDEX, titled("apple"), Some(&format!("doc-{at}")))
                .expect("the write succeeds beside a panicking listener");
        }
        writer.remove(INDEX, "doc-0").expect("the removal succeeds");
    });
    assert_eq!(*counts.lock().expect("the log locks"), vec![1, 2, 3, 2]);
    assert!(narsil.off(counting), "the listener was registered");
    assert!(!narsil.off(counting), "the listener was removed already");
    assert!(
        narsil.off(panicking),
        "the panicking listener was registered"
    );
    narsil
        .insert(INDEX, titled("apple"), Some("doc-9"))
        .expect("the write succeeds");
    assert_eq!(
        counts.lock().expect("the log locks").len(),
        4,
        "a removed listener heard a write"
    );
}

#[test]
fn a_restore_tells_write_listeners_once_the_restored_documents_answer_searches() {
    let narsil = Arc::new(Narsil::new());
    narsil
        .create_index(INDEX, index_config(None))
        .expect("the index is created");
    narsil
        .insert(INDEX, titled("apple"), Some("doc-0"))
        .expect("the write succeeds");
    let mut snapshot = Vec::new();
    narsil
        .snapshot(INDEX, &mut snapshot)
        .expect("the snapshot is written");
    for at in 1..3 {
        narsil
            .insert(INDEX, titled("apple"), Some(&format!("doc-{at}")))
            .expect("the write succeeds");
    }
    let heard = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&heard);
    let engine: Weak<Narsil> = Arc::downgrade(&narsil);
    narsil.on(NarsilEventKind::Write, move |event| {
        let (Some(engine), NarsilEvent::Write { index_name }) = (engine.upgrade(), event) else {
            return;
        };
        let found = search(&engine, "apple").unwrap_or_default();
        log.lock()
            .expect("the log locks")
            .push((index_name.clone(), found));
    });
    let restorer = Arc::clone(&narsil);
    within_limit(move || {
        restorer
            .restore(INDEX, &mut snapshot.as_slice())
            .expect("the snapshot restores");
    });
    assert_eq!(
        *heard.lock().expect("the log locks"),
        vec![(INDEX.to_string(), vec!["doc-0".to_string()])]
    );
}

#[test]
fn the_watermark_reports_each_crossing_once() {
    let narsil = Narsil::new();
    narsil
        .create_index(
            INDEX,
            index_config(Some(PartitionConfig {
                max_docs_per_partition: Some(10),
                watermark: Some(0.5),
                ..PartitionConfig::default()
            })),
        )
        .expect("the index is created");
    let reports = Arc::new(Mutex::new(Vec::new()));
    let heard = Arc::clone(&reports);
    narsil.on(NarsilEventKind::PartitionWatermark, move |event| {
        if let NarsilEvent::PartitionWatermark {
            document_count,
            capacity,
            ..
        } = event
        {
            heard
                .lock()
                .expect("the log locks")
                .push((*document_count, *capacity));
        }
    });
    let insert = |at: u64| {
        narsil
            .insert(INDEX, titled("apple"), Some(&format!("doc-{at}")))
            .expect("the write succeeds");
    };
    for at in 0..7 {
        insert(at);
    }
    for id in ["doc-0", "doc-1", "doc-2"] {
        narsil.remove(INDEX, id).expect("the removal succeeds");
    }
    insert(7);
    narsil
        .update_partition_config(
            INDEX,
            &PartitionConfig {
                max_docs_per_partition: Some(12),
                ..PartitionConfig::default()
            },
        )
        .expect("the capacity rises");
    insert(8);
    assert_eq!(
        *reports.lock().expect("the log locks"),
        vec![(5, 10), (5, 10), (6, 12)]
    );
}

#[derive(Default)]
struct Recorder {
    engine: Mutex<Weak<Narsil>>,
    log: Mutex<Vec<String>>,
}

impl Recorder {
    fn note(&self, line: String) {
        self.log.lock().expect("the log locks").push(line);
    }

    fn lines(&self) -> Vec<String> {
        self.log.lock().expect("the log locks").clone()
    }
}

fn title(document: &Map) -> &str {
    match document.get("title") {
        Some(Value::String(title)) => title,
        _ => "",
    }
}

impl Plugin for Recorder {
    fn name(&self) -> &str {
        "recorder"
    }

    fn before_insert(
        &self,
        index_name: &str,
        doc_id: &str,
        document: &mut Map,
    ) -> narsil::Result<()> {
        match title(document) {
            "refuse" => Err(NarsilError::new(
                ErrorCode::DOC_VALIDATION_FAILED,
                "the recorder refuses it",
            )),
            "panic" => panic!("the recorder panics"),
            _ => {
                if let Some(engine) = self.engine.lock().expect("the engine locks").upgrade() {
                    let held = engine.has(index_name, doc_id).unwrap_or(true);
                    self.note(format!("before insert {doc_id} held {held}"));
                }
                document.insert("tag", Value::String("enriched".into()));
                Ok(())
            }
        }
    }

    fn after_insert(&self, _index_name: &str, doc_id: &str, document: &Map) {
        self.note(format!("after insert {doc_id} {}", title(document)));
    }

    fn before_update(
        &self,
        _index_name: &str,
        doc_id: &str,
        old_document: &Map,
        new_document: &mut Map,
    ) -> narsil::Result<()> {
        self.note(format!(
            "before update {doc_id} from {}",
            title(old_document)
        ));
        new_document.insert("tag", Value::String("revised".into()));
        Ok(())
    }

    fn after_update(&self, _index_name: &str, doc_id: &str, _old: &Map, new_document: &Map) {
        self.note(format!("after update {doc_id} {}", title(new_document)));
    }

    fn before_remove(&self, _index_name: &str, doc_id: &str) -> narsil::Result<()> {
        if doc_id == "keep" {
            return Err(NarsilError::new(
                ErrorCode::DOC_VALIDATION_FAILED,
                "the recorder keeps it",
            ));
        }
        Ok(())
    }

    fn after_remove(&self, _index_name: &str, doc_id: &str) {
        self.note(format!("after remove {doc_id}"));
    }

    fn before_search(&self, _index_name: &str, params: &mut QueryParams) -> narsil::Result<()> {
        match params.term.as_deref() {
            Some("secret") => Err(NarsilError::new(
                ErrorCode::CONFIG_INVALID,
                "the recorder hides it",
            )),
            Some("alias") => {
                params.term = Some("enriched".into());
                Ok(())
            }
            _ => Ok(()),
        }
    }

    fn after_search(&self, _index_name: &str, params: &QueryParams, result: &QueryResult) {
        self.note(format!(
            "after search {} found {}",
            params.term.as_deref().unwrap_or_default(),
            result.hits.len()
        ));
    }

    fn on_index_create(&self, index_name: &str, _config: &IndexConfig) {
        self.note(format!("created {index_name}"));
    }

    fn on_index_drop(&self, index_name: &str, _config: &IndexConfig) {
        self.note(format!("dropped {index_name}"));
    }

    fn on_partition_split(&self, index_name: &str, old_count: usize, new_count: usize) {
        self.note(format!("split {index_name} {old_count} to {new_count}"));
    }
}

fn require_code<T: std::fmt::Debug>(
    outcome: narsil::Result<T>,
    code: ErrorCode,
    message: Option<&str>,
) {
    let error = outcome.expect_err("the hook refuses the call");
    assert_eq!(error.code(), code, "{}", error.message());
    if let Some(message) = message {
        assert_eq!(error.message(), message);
    }
}

#[test]
fn plugins_enrich_refuse_and_observe_every_write_and_search() {
    let narsil = Arc::new(Narsil::new());
    let recorder = Arc::new(Recorder::default());
    *recorder.engine.lock().expect("the engine locks") = Arc::downgrade(&narsil);
    narsil.add_plugin(Arc::clone(&recorder) as Arc<dyn Plugin>);
    narsil
        .create_index(
            INDEX,
            index_config(Some(PartitionConfig {
                max_partitions: Some(4),
                ..PartitionConfig::default()
            })),
        )
        .expect("the index is created");
    let engine = Arc::clone(&narsil);
    let generated = within_limit(move || {
        engine
            .insert(INDEX, titled("apple"), None)
            .expect("the enriched write succeeds")
    });
    let stored = narsil.get(INDEX, &generated).expect("the read answers");
    assert_eq!(
        stored.and_then(|document| document.get("tag").cloned()),
        Some(Value::String("enriched".into()))
    );
    require_code(
        narsil.insert(INDEX, titled("refuse"), Some("refused")),
        ErrorCode::DOC_VALIDATION_FAILED,
        Some("the recorder refuses it"),
    );
    require_code(
        narsil.insert(INDEX, titled("panic"), Some("panicked")),
        ErrorCode::DOC_VALIDATION_FAILED,
        None,
    );
    for id in ["refused", "panicked"] {
        assert_eq!(
            narsil.get(INDEX, id).expect("the read answers"),
            None,
            "{id} was stored"
        );
    }
    let batch = narsil
        .insert_batch(
            INDEX,
            vec![
                with_id("first", "pear"),
                with_id("second", "refuse"),
                with_id("third", "panic"),
                titled("plum"),
                with_id("first", "pear again"),
            ],
        )
        .expect("the batch answers");
    let mut refused: Vec<(String, ErrorCode)> = batch
        .failed
        .iter()
        .map(|failure| (failure.doc_id.clone(), failure.error.code()))
        .collect();
    refused.sort_by(|left, right| left.0.cmp(&right.0));
    assert_eq!(
        refused,
        vec![
            ("first".to_string(), ErrorCode::DOC_ALREADY_EXISTS),
            ("second".to_string(), ErrorCode::DOC_VALIDATION_FAILED),
            ("third".to_string(), ErrorCode::DOC_VALIDATION_FAILED),
        ]
    );
    assert_eq!(batch.succeeded.len(), 2);
    let plum = batch.succeeded[1].clone();
    assert_eq!(narsil.count_documents(INDEX).expect("the count reads"), 3);
    narsil
        .update(INDEX, "first", with_id("first", "pear ripe"))
        .expect("the update succeeds");
    require_code(
        narsil.remove(INDEX, "keep"),
        ErrorCode::DOC_VALIDATION_FAILED,
        Some("the recorder keeps it"),
    );
    narsil.remove(INDEX, &plum).expect("the removal succeeds");
    assert_eq!(
        search(&narsil, "alias").expect("the rewritten search answers"),
        vec![generated.clone()]
    );
    require_code(
        search(&narsil, "secret"),
        ErrorCode::CONFIG_INVALID,
        Some("the recorder hides it"),
    );
    narsil.rebalance(INDEX, 2).expect("the rebalance succeeds");
    narsil.drop_index(INDEX).expect("the index drops");
    let expected = vec![
        format!("created {INDEX}"),
        format!("before insert {generated} held false"),
        format!("after insert {generated} apple"),
        "before insert first held false".to_string(),
        format!("before insert {plum} held false"),
        "before insert first held false".to_string(),
        "after insert first pear".to_string(),
        format!("after insert {plum} plum"),
        "before update first from pear".to_string(),
        "after update first pear ripe".to_string(),
        format!("after remove {plum}"),
        "after search enriched found 1".to_string(),
        format!("split {INDEX} 4 to 2"),
        format!("dropped {INDEX}"),
    ];
    assert_eq!(recorder.lines(), expected);
}

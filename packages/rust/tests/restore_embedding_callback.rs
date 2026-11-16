mod support;

use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use narsil::{
    AdapterSetting, EmbeddingConfig, ErrorCode, IndexConfig, Map, Narsil, QueryParams, Storage,
    Value, VectorQuery, parse_json,
};
use support::ScratchDirectory;
use support::adapters::EmbedWith;
use support::portable::{Tier, snapshot_of};

const INDEX: &str = "documents";
const CHILD_DIRECTORY: &str = "NARSIL_RESTORE_EMBEDDING_CALLBACK_DIRECTORY";
const SEARCH_DEADLINE: Duration = Duration::from_secs(60);
const CHILD_SETUP_DEADLINE: Duration = Duration::from_secs(300);
const POLL_INTERVAL: Duration = Duration::from_millis(10);
const SEARCH_STARTING: &str = "The target engine is starting its search";
const SEARCH_FINISHED: &str = "The target engine finished its search";
const CALLBACK_ENTERED: &str = "The replacement adapter is restoring the index";
const QUERY_EMBEDDINGS_BEFORE_REFUSAL: usize = 3;

fn config(adapter: &str) -> IndexConfig {
    IndexConfig {
        schema: parse_json(r#"{"title":"string","embedding":"vector[2]"}"#).unwrap(),
        text_storage: Some(Storage::Disk),
        embedding: Some(EmbeddingConfig {
            fields: vec![("embedding".into(), vec!["title".into()])],
            adapter: Some(AdapterSetting::Named(adapter.into())),
        }),
        ..IndexConfig::default()
    }
}

fn insert(engine: &Narsil, id: &str, vector: [f64; 2]) {
    let mut document = Map::new();
    document.insert("title", Value::String(id.into()));
    document.insert(
        "embedding",
        Value::Array(vector.into_iter().map(Value::Number).collect()),
    );
    engine.insert(INDEX, document, Some(id)).unwrap();
}

fn search_params() -> QueryParams {
    QueryParams {
        vector: Some(VectorQuery {
            field: "embedding".into(),
            text: Some("search".into()),
            similarity: Some(0.9),
            ..VectorQuery::default()
        }),
        ..QueryParams::default()
    }
}

fn search_with_restoring_adapters(root: &Path, preflight: bool) {
    let source = Tier::Log.open(&root.join("source"));
    source
        .register_embedding_adapter(
            "replacement",
            Arc::new(EmbedWith {
                dimensions: 2,
                embed: |_: &str| Ok(vec![0.0, 1.0]),
            }),
        )
        .unwrap();
    source.create_index(INDEX, config("replacement")).unwrap();
    insert(&source, "wanted", [0.0, 1.0]);
    insert(&source, "decoy", [1.0, 0.0]);
    let archive = Arc::new(snapshot_of(&source, INDEX));
    source.shutdown().unwrap();

    let target = Arc::new(Tier::Log.open(&root.join("target")));
    let replacement_target = Arc::downgrade(&target);
    let replacement_archive = Arc::clone(&archive);
    let restore_once = AtomicBool::new(true);
    target
        .register_embedding_adapter(
            "replacement",
            Arc::new(EmbedWith {
                dimensions: 2,
                embed: move |_: &str| {
                    if restore_once.swap(false, Ordering::SeqCst) {
                        eprintln!("{CALLBACK_ENTERED}");
                        replacement_target
                            .upgrade()
                            .unwrap()
                            .restore(INDEX, &mut replacement_archive.as_slice())?;
                    }
                    Ok(vec![0.0, 1.0])
                },
            }),
        )
        .unwrap();
    let original_target = Arc::downgrade(&target);
    target
        .register_embedding_adapter(
            "original",
            Arc::new(EmbedWith {
                dimensions: 2,
                embed: move |_: &str| {
                    original_target
                        .upgrade()
                        .unwrap()
                        .restore(INDEX, &mut archive.as_slice())?;
                    Ok(vec![1.0, 0.0])
                },
            }),
        )
        .unwrap();
    target.create_index(INDEX, config("original")).unwrap();
    insert(&target, "original", [1.0, 0.0]);
    target.checkpoint(INDEX).unwrap();

    let params = search_params();
    eprintln!("{SEARCH_STARTING}");
    if preflight {
        assert_eq!(target.preflight(INDEX, &params).unwrap().count, 1);
    } else {
        let answer = target.query(INDEX, &params).unwrap();
        let ids: Vec<_> = answer.hits.iter().map(|hit| hit.id.as_str()).collect();
        assert_eq!(ids, vec!["wanted"]);
    }
    eprintln!("{SEARCH_FINISHED}");
    assert!(target.get(INDEX, "wanted").unwrap().is_some());
    target.shutdown().unwrap();
}

fn forward_lines(
    stream: impl Read + Send + 'static,
    lines: mpsc::Sender<String>,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut line = Vec::new();
        while reader.read_until(b'\n', &mut line).unwrap_or(0) > 0 {
            if lines
                .send(String::from_utf8_lossy(&line).into_owned())
                .is_err()
            {
                return;
            }
            line.clear();
        }
    })
}

#[derive(Debug, PartialEq)]
enum ChildStage {
    SettingUp,
    Searching,
    FinishingUp,
}

struct ChildOutcome {
    status: Option<ExitStatus>,
    stage: ChildStage,
    output: String,
}

struct ChildProgress {
    stage: ChildStage,
    stage_started: Instant,
    output: String,
}

impl ChildProgress {
    fn record(&mut self, line: String) {
        let next = match self.stage {
            ChildStage::SettingUp if line.contains(SEARCH_STARTING) => Some(ChildStage::Searching),
            ChildStage::Searching if line.contains(SEARCH_FINISHED) => {
                Some(ChildStage::FinishingUp)
            }
            _ => None,
        };
        if let Some(next) = next {
            self.stage = next;
            self.stage_started = Instant::now();
        }
        self.output.push_str(&line);
    }

    fn overdue(&self) -> bool {
        let deadline = match self.stage {
            ChildStage::Searching => SEARCH_DEADLINE,
            ChildStage::SettingUp | ChildStage::FinishingUp => CHILD_SETUP_DEADLINE,
        };
        self.stage_started.elapsed() >= deadline
    }
}

fn watch_child(mut child: Child) -> ChildOutcome {
    let (sender, lines) = mpsc::channel();
    let readers = [
        forward_lines(child.stdout.take().unwrap(), sender.clone()),
        forward_lines(child.stderr.take().unwrap(), sender),
    ];
    let mut progress = ChildProgress {
        stage: ChildStage::SettingUp,
        stage_started: Instant::now(),
        output: String::new(),
    };
    let status = loop {
        lines.try_iter().for_each(|line| progress.record(line));
        if let Some(status) = child.try_wait().unwrap() {
            break Some(status);
        }
        if progress.overdue() {
            child.kill().unwrap();
            child.wait().unwrap();
            break None;
        }
        std::thread::sleep(POLL_INTERVAL);
    };
    for reader in readers {
        reader.join().unwrap();
    }
    lines.try_iter().for_each(|line| progress.record(line));
    ChildOutcome {
        status,
        stage: progress.stage,
        output: progress.output,
    }
}

fn require_callback_finishes(test: &str, preflight: bool) {
    if let Some(root) = std::env::var_os(CHILD_DIRECTORY) {
        search_with_restoring_adapters(Path::new(&root), preflight);
        return;
    }
    let root = ScratchDirectory::new(test);
    let child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test, "--nocapture", "--test-threads=1"])
        .env(CHILD_DIRECTORY, root.path())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let ChildOutcome {
        status,
        stage,
        output,
    } = watch_child(child);
    assert_ne!(
        stage,
        ChildStage::SettingUp,
        "the child must reach its search within {CHILD_SETUP_DEADLINE:?}: {output}"
    );
    assert!(
        output.contains(CALLBACK_ENTERED),
        "the replacement adapter must reach its restore callback: {output}"
    );
    assert!(
        status.is_some() || stage != ChildStage::Searching,
        "the search deadlocked while its adapter restored the index: {output}"
    );
    let Some(status) = status else {
        panic!("the child must exit within {CHILD_SETUP_DEADLINE:?} of its search: {output}");
    };
    assert!(status.success(), "{output}");
}

#[test]
fn a_query_allows_a_replacement_embedding_adapter_to_restore_the_index() {
    require_callback_finishes(
        "a_query_allows_a_replacement_embedding_adapter_to_restore_the_index",
        false,
    );
}

#[test]
fn a_preflight_allows_a_replacement_embedding_adapter_to_restore_the_index() {
    require_callback_finishes(
        "a_preflight_allows_a_replacement_embedding_adapter_to_restore_the_index",
        true,
    );
}

fn archive_with_adapter(root: &Path, adapter: &str) -> Vec<u8> {
    let source = Tier::Log.open(root);
    source
        .register_embedding_adapter(
            adapter,
            Arc::new(EmbedWith {
                dimensions: 2,
                embed: |_: &str| Ok(vec![0.0, 1.0]),
            }),
        )
        .unwrap();
    source.create_index(INDEX, config(adapter)).unwrap();
    insert(&source, "wanted", [0.0, 1.0]);
    let archive = snapshot_of(&source, INDEX);
    source.shutdown().unwrap();
    archive
}

fn register_restoring_adapter(
    engine: &Arc<Narsil>,
    adapter: &str,
    archive: Vec<u8>,
    embeddings: &Arc<AtomicUsize>,
) {
    let restoring = Arc::downgrade(engine);
    let counted = Arc::clone(embeddings);
    engine
        .register_embedding_adapter(
            adapter,
            Arc::new(EmbedWith {
                dimensions: 2,
                embed: move |_: &str| {
                    counted.fetch_add(1, Ordering::SeqCst);
                    restoring
                        .upgrade()
                        .unwrap()
                        .restore(INDEX, &mut archive.as_slice())?;
                    Ok(vec![0.0, 1.0])
                },
            }),
        )
        .unwrap();
}

fn require_refusal_after_alternating_adapters(
    test: &str,
    search: fn(&Narsil) -> narsil::Result<()>,
) {
    let root = ScratchDirectory::new(test);
    let first = archive_with_adapter(&root.path().join("first-source"), "first");
    let second = archive_with_adapter(&root.path().join("second-source"), "second");
    let target = Arc::new(Tier::Log.open(&root.path().join("target")));
    let embeddings = Arc::new(AtomicUsize::new(0));
    register_restoring_adapter(&target, "first", second, &embeddings);
    register_restoring_adapter(&target, "second", first, &embeddings);
    target.create_index(INDEX, config("first")).unwrap();
    insert(&target, "original", [1.0, 0.0]);
    target.checkpoint(INDEX).unwrap();

    let (finished, outcome) = mpsc::channel();
    let searching = Arc::clone(&target);
    std::thread::spawn(move || finished.send(search(&searching)).unwrap());
    let error = outcome
        .recv_timeout(SEARCH_DEADLINE)
        .expect("the search finishes while its adapters restore the index")
        .expect_err("the search refuses once restores keep changing its adapter");
    assert_eq!(error.code(), ErrorCode::WORKER_BUSY, "{error}");
    assert_eq!(
        embeddings.load(Ordering::SeqCst),
        QUERY_EMBEDDINGS_BEFORE_REFUSAL
    );
    assert!(target.get(INDEX, "wanted").unwrap().is_some());
    target.shutdown().unwrap();
}

#[test]
fn a_query_refuses_once_restores_keep_changing_its_embedding_adapter() {
    require_refusal_after_alternating_adapters(
        "a_query_refuses_once_restores_keep_changing_its_embedding_adapter",
        |engine| engine.query(INDEX, &search_params()).map(|_| ()),
    );
}

#[test]
fn a_preflight_refuses_once_restores_keep_changing_its_embedding_adapter() {
    require_refusal_after_alternating_adapters(
        "a_preflight_refuses_once_restores_keep_changing_its_embedding_adapter",
        |engine| engine.preflight(INDEX, &search_params()).map(|_| ()),
    );
}

mod support;

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use narsil::{IndexConfig, Map, Narsil, QueryParams, Storage, Value, VectorPromotion};
use sha2::{Digest, Sha256};
use support::ScratchDirectory;
use support::portable::{
    Tier, documents, every_id, fill, held_documents, index_config, snapshot_of,
};

const INDEX: &str = "books";
const SEARCHED_WORD: &str = "harbour";
const FIRST_SEEDS: std::ops::Range<u64> = 0..240;
const SECOND_SEEDS: std::ops::Range<u64> = 0..180;
const GRAPH_THRESHOLD: u64 = 64;
const READERS: usize = 4;
const RESTORE_ROUNDS: usize = 6;
const SAMPLE_STEP: usize = 9;
const WIDE_LIMIT: usize = 1_000;
const STAGED_DIRECTORY: &str = ".restore-crashed";
const RETIRED_DIRECTORY: &str = ".retired-crashed";
const SWAP_LEFTOVER_PREFIXES: [&str; 3] = [".restore-", ".retired-", ".swap-"];

fn files_on_disk_config() -> IndexConfig {
    IndexConfig {
        text_storage: Some(Storage::Disk),
        vector_promotion: Some(VectorPromotion {
            threshold: Some(GRAPH_THRESHOLD),
            storage: Some(Storage::Disk),
            ..VectorPromotion::default()
        }),
        ..index_config()
    }
}

struct Archived {
    documents: BTreeMap<String, Map>,
    archive: Vec<u8>,
}

fn archived(prefix: &str, seeds: std::ops::Range<u64>) -> Archived {
    let root = ScratchDirectory::new(&format!("restore-swap-source-{prefix}"));
    let source = Tier::Log.open(root.path());
    source
        .create_index("source", files_on_disk_config())
        .expect("the source index is created");
    let documents = documents(prefix, seeds);
    fill(&source, "source", &documents);
    source.checkpoint("source").expect("the checkpoint writes");
    let archive = snapshot_of(&source, "source");
    source.shutdown().expect("the source engine shuts down");
    Archived { documents, archive }
}

fn words_of(document: &Map) -> Vec<String> {
    let mut words = Vec::new();
    if let Some(Value::String(title)) = document.get("title") {
        words.extend(title.split_whitespace().map(str::to_lowercase));
    }
    if let Some(Value::Array(tags)) = document.get("tags") {
        words.extend(tags.iter().filter_map(Value::as_str).map(str::to_lowercase));
    }
    words
}

fn ids_holding(documents: &BTreeMap<String, Map>, word: &str) -> BTreeSet<String> {
    documents
        .iter()
        .filter(|(_, document)| words_of(document).iter().any(|found| found == word))
        .map(|(id, _)| id.clone())
        .collect()
}

fn found_ids(narsil: &Narsil, word: &str) -> BTreeSet<String> {
    let params = QueryParams {
        term: Some(word.to_string()),
        limit: Some(WIDE_LIMIT),
        ..QueryParams::default()
    };
    narsil
        .query(INDEX, &params)
        .expect("the term query runs")
        .hits
        .into_iter()
        .map(|hit| hit.id)
        .collect()
}

struct Expected {
    count: u64,
    found: BTreeSet<String>,
    sample: BTreeMap<String, Map>,
}

fn expected_of(documents: &BTreeMap<String, Map>, sample_ids: &[String]) -> Expected {
    Expected {
        count: documents.len() as u64,
        found: ids_holding(documents, SEARCHED_WORD),
        sample: sample_ids
            .iter()
            .filter_map(|id| {
                documents
                    .get(id)
                    .map(|document| (id.clone(), document.clone()))
            })
            .collect(),
    }
}

fn require_one_archive(choices: &[Expected], matches: impl Fn(&Expected) -> bool, what: &str) {
    assert!(
        choices.iter().any(matches),
        "{what} matched neither archive"
    );
}

fn read_one_of_each(narsil: &Narsil, sample_ids: &[String], choices: &[Expected]) {
    let count = narsil.count_documents(INDEX).expect("the count reads");
    require_one_archive(choices, |expected| expected.count == count, "the count");
    let found = found_ids(narsil, SEARCHED_WORD);
    require_one_archive(choices, |expected| expected.found == found, "the search");
    let sample = held_documents(narsil, INDEX, sample_ids);
    require_one_archive(
        choices,
        |expected| expected.sample == sample,
        "the documents",
    );
}

fn require_whole(narsil: &Narsil, ids: &[String], documents: &BTreeMap<String, Map>) {
    assert_eq!(&held_documents(narsil, INDEX, ids), documents);
    assert_eq!(
        narsil.count_documents(INDEX).expect("the count reads"),
        documents.len() as u64
    );
    assert_eq!(
        found_ids(narsil, SEARCHED_WORD),
        ids_holding(documents, SEARCHED_WORD)
    );
}

fn opened_with(root: &Path, documents: &Archived) -> Narsil {
    let narsil = Tier::Log.open(root);
    narsil
        .create_index(INDEX, files_on_disk_config())
        .expect("the index is created");
    narsil
        .restore(INDEX, &mut documents.archive.as_slice())
        .expect("the first archive restores");
    narsil.checkpoint(INDEX).expect("the checkpoint writes");
    narsil.shutdown().expect("the engine shuts down");
    drop(narsil);
    Tier::Log.open(root)
}

fn swap_leftovers(root: &Path) -> Vec<String> {
    std::fs::read_dir(root)
        .expect("the durability directory lists")
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|name| {
            SWAP_LEFTOVER_PREFIXES
                .iter()
                .any(|prefix| name.starts_with(prefix))
        })
        .collect()
}

#[test]
fn searches_throughout_restores_read_one_whole_index_and_never_fail() {
    let first = archived("alpha", FIRST_SEEDS);
    let second = archived("beta", SECOND_SEEDS);
    let ids = every_id([&first.documents, &second.documents]);
    let sample_ids: Vec<String> = ids.iter().step_by(SAMPLE_STEP).cloned().collect();
    let choices = Arc::new([
        expected_of(&first.documents, &sample_ids),
        expected_of(&second.documents, &sample_ids),
    ]);
    let root = ScratchDirectory::new("restore-swap-reads");
    let target = Arc::new(opened_with(root.path(), &first));
    let stop = Arc::new(AtomicBool::new(false));
    let reads = Arc::new(AtomicU64::new(0));
    let readers: Vec<_> = (0..READERS)
        .map(|_| {
            let (target, stop, reads) = (target.clone(), stop.clone(), reads.clone());
            let (choices, sample_ids) = (choices.clone(), sample_ids.clone());
            std::thread::spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    read_one_of_each(&target, &sample_ids, &choices[..]);
                    reads.fetch_add(1, Ordering::SeqCst);
                }
            })
        })
        .collect();
    let mut last = &first;
    for round in 0..RESTORE_ROUNDS {
        let next = if round % 2 == 0 { &second } else { &first };
        last = next;
        let reads_before = reads.load(Ordering::SeqCst);
        target
            .restore(INDEX, &mut next.archive.as_slice())
            .expect("the archive restores while searches run");
        require_whole(&target, &ids, &next.documents);
        while reads.load(Ordering::SeqCst) <= reads_before
            && !readers.iter().any(std::thread::JoinHandle::is_finished)
        {
            std::thread::yield_now();
        }
    }
    stop.store(true, Ordering::SeqCst);
    for reader in readers {
        reader.join().expect("every read matched one archive");
    }
    target.shutdown().expect("the engine shuts down");
    drop(target);
    assert_eq!(swap_leftovers(root.path()), Vec::<String>::new());
    let reopened = Tier::Log.open(root.path());
    require_whole(&reopened, &ids, &last.documents);
}

#[cfg(windows)]
#[test]
fn a_restore_whose_move_fails_leaves_the_old_index_answering_searches_and_writes() {
    use std::os::windows::fs::OpenOptionsExt;

    let first = archived("alpha", FIRST_SEEDS);
    let second = archived("beta", SECOND_SEEDS);
    let root = ScratchDirectory::new("restore-swap-held");
    let target = opened_with(root.path(), &first);
    let later = documents("later", 0..30);
    let added = documents("added", 0..20);
    let every = every_id([&first.documents, &second.documents, &later, &added]);
    fill(&target, INDEX, &later);
    let mut expected = first.documents.clone();
    expected.extend(later);
    let held_path = root.path().join(INDEX).join("held-by-another-program");
    std::fs::write(&held_path, b"held").expect("the held file writes");
    let held = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&held_path)
        .expect("the held file opens with no sharing");

    let refused = target
        .restore(INDEX, &mut second.archive.as_slice())
        .expect_err("the restore moved a directory that another program holds open");
    assert_eq!(refused.code(), narsil::ErrorCode::PERSISTENCE_SAVE_FAILED);
    assert_eq!(held_documents(&target, INDEX, &every), expected);
    assert_eq!(
        found_ids(&target, SEARCHED_WORD),
        ids_holding(&expected, SEARCHED_WORD)
    );
    fill(&target, INDEX, &added);
    expected.extend(added);
    assert_eq!(held_documents(&target, INDEX, &every), expected);
    drop(held);
    target.shutdown().expect("the engine shuts down");
    drop(target);
    assert_eq!(swap_leftovers(root.path()), Vec::<String>::new());

    let reopened = Tier::Log.open(root.path());
    assert_eq!(held_documents(&reopened, INDEX, &every), expected);
    reopened
        .restore(INDEX, &mut second.archive.as_slice())
        .expect("the archive restores once no program holds the directory");
    assert_eq!(held_documents(&reopened, INDEX, &every), second.documents);
}

fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).expect("the copy's directory is made");
    for entry in std::fs::read_dir(from).expect("the directory lists") {
        let entry = entry.expect("the entry reads");
        let target = to.join(entry.file_name());
        if entry.file_type().expect("the entry's type reads").is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).expect("the file copies");
        }
    }
}

fn journal_name(index: &str) -> String {
    let digest = Sha256::digest(index.as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(".swap-{hex}")
}

#[test]
fn a_crash_between_the_two_moves_of_a_restore_finishes_the_restore_at_the_next_start() {
    let first = archived("alpha", FIRST_SEEDS);
    let second = archived("beta", SECOND_SEEDS);
    let ids = every_id([&first.documents, &second.documents]);
    let staged_root = ScratchDirectory::new("restore-swap-staged");
    opened_with(staged_root.path(), &second)
        .shutdown()
        .expect("the staged engine shuts down");
    let root = ScratchDirectory::new("restore-swap-crash");
    let target = opened_with(root.path(), &first);
    let later = documents("later", 0..30);
    fill(&target, INDEX, &later);
    target.shutdown().expect("the engine shuts down");
    drop(target);

    copy_tree(
        &staged_root.path().join(INDEX),
        &root.path().join(STAGED_DIRECTORY),
    );
    std::fs::rename(root.path().join(INDEX), root.path().join(RETIRED_DIRECTORY))
        .expect("the index's directory moves aside");
    std::fs::write(
        root.path().join(journal_name(INDEX)),
        format!("{INDEX}\n{STAGED_DIRECTORY}/"),
    )
    .expect("the journal writes");

    let recovered = Tier::Log.open(root.path());
    let every = every_id([&first.documents, &second.documents, &later]);
    require_whole(&recovered, &ids, &second.documents);
    assert_eq!(held_documents(&recovered, INDEX, &every), second.documents);
    assert_eq!(swap_leftovers(root.path()), Vec::<String>::new());
    let mut expected = second.documents.clone();
    fill(&recovered, INDEX, &later);
    expected.extend(later);
    recovered.shutdown().expect("the engine shuts down");
    drop(recovered);
    let reopened = Tier::Log.open(root.path());
    assert_eq!(held_documents(&reopened, INDEX, &every), expected);
}

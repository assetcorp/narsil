mod support;

use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use narsil::{
    Map, Narsil, NarsilEvent, NarsilEventKind, QuerySuggestionsBuildStatus,
    QuerySuggestionsSetting, RecordQueryOutcome, Value,
};
use support::ScratchDirectory;
use support::suggestions::{
    INDEX, KEY, VOCABULARY, body_index, corpus, create_with_corpus, killed_after,
    matching_documents, open, search, setting, suggestions_of, taken, warnings_of,
};

const SAVING_CHILD: &str = "NARSIL_SUGGESTIONS_SAVE_CRASH_DIRECTORY";
const BUILDING_CHILD: &str = "NARSIL_SUGGESTIONS_BUILD_CRASH_DIRECTORY";
const SAVED_PHRASES: usize = 5;
const SAVE_ACKNOWLEDGEMENTS: usize = 1_500;
const SAVE_INTERVAL_MS: u32 = 1_000;
const RECORD_PAUSE: Duration = Duration::from_millis(2);
const SEARCHES_AFTER_RECOVERY: u64 = 10;
const BUILD_PHRASES: usize = 2_000;
const PHRASES_PER_PERSON: usize = 1_000;
const PEOPLE_PER_DAY: u32 = 100;
const WORDS_PER_DOCUMENT: usize = 10;
const BUILD_ACKNOWLEDGEMENTS: usize = 1;
const CONSONANTS: &[u8] = b"bdfgklmnprtvz";
const VOWELS: &[u8] = b"aou";
const WORD_LETTERS: usize = 6;

fn saved_phrase(at: u64) -> &'static str {
    VOCABULARY[(at % SAVED_PHRASES as u64) as usize]
}

fn counts_by_phrase(narsil: &Narsil) -> BTreeMap<String, u64> {
    narsil
        .query_suggestions()
        .preview(INDEX, Some(1_000))
        .expect("the preview reads")
        .entries
        .into_iter()
        .map(|entry| (entry.query, entry.count))
        .collect()
}

fn announce(line: &str) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

#[test]
fn query_suggestions_child_recorder() {
    let Some(root) = std::env::var_os(SAVING_CHILD) else {
        return;
    };
    let narsil = open(Path::new(&root), Some(KEY));
    let suggestions = narsil.query_suggestions();
    for at in 0u64.. {
        let result = suggestions
            .record_query(
                INDEX,
                &search(saved_phrase(at), &format!("crash-{at}"), "web"),
            )
            .expect("the child counts the search");
        assert_eq!(result.outcome, RecordQueryOutcome::Recorded);
        announce(&format!("ACK {at}"));
        std::thread::sleep(RECORD_PAUSE);
    }
}

#[test]
fn a_kill_between_saves_leaves_a_history_that_the_next_engine_reads_and_extends() {
    let scratch = ScratchDirectory::new("suggestions-save-crash");
    let root = scratch.path();
    let corpus = corpus();
    for phrase in &VOCABULARY[..SAVED_PHRASES] {
        assert!(matching_documents(phrase, &corpus) > 0);
    }
    let narsil = open(root, Some(KEY));
    create_with_corpus(&narsil, INDEX, &corpus);
    narsil
        .query_suggestions()
        .update_setting(
            INDEX,
            &QuerySuggestionsSetting {
                save_interval_ms: Some(SAVE_INTERVAL_MS),
                ..setting(2, 1)
            },
        )
        .expect("the feature turns on");
    narsil.shutdown().expect("the engine shuts down");

    let last = killed_after(
        "query_suggestions_child_recorder",
        SAVING_CHILD,
        root,
        SAVE_ACKNOWLEDGEMENTS,
    )
    .expect("the child acknowledged searches");
    let narsil = open(root, Some(KEY));
    let warnings = warnings_of(&narsil);
    let recovered = counts_by_phrase(&narsil);
    let mut sent = [0u64; SAVED_PHRASES];
    for at in 0..=last + 1 {
        sent[(at % SAVED_PHRASES as u64) as usize] += 1;
    }
    for (at, phrase) in VOCABULARY[..SAVED_PHRASES].iter().enumerate() {
        let held = recovered.get(*phrase).copied().unwrap_or(0);
        assert!(
            held >= 2,
            "a save during the run kept the counts of {phrase}"
        );
        assert!(
            held <= sent[at],
            "{phrase} counts {held} people, more than the {} that the child sent",
            sent[at]
        );
    }

    let suggestions = narsil.query_suggestions();
    for at in 0..SEARCHES_AFTER_RECOVERY {
        let result = suggestions
            .record_query(INDEX, &search(VOCABULARY[0], &format!("after-{at}"), "web"))
            .expect("the recovered engine counts searches");
        assert_eq!(result.outcome, RecordQueryOutcome::Recorded);
    }
    narsil.shutdown().expect("the engine shuts down");
    let narsil = open(root, Some(KEY));
    let reopened_warnings = warnings_of(&narsil);
    let extended = counts_by_phrase(&narsil);
    for phrase in &VOCABULARY[..SAVED_PHRASES] {
        let added = if *phrase == VOCABULARY[0] {
            SEARCHES_AFTER_RECOVERY
        } else {
            0
        };
        assert_eq!(
            extended.get(*phrase).copied(),
            recovered.get(*phrase).map(|held| held + added),
            "the save after recovery keeps every count of {phrase}"
        );
    }
    assert!(
        taken(&warnings).is_empty(),
        "the crash damaged no history file"
    );
    assert!(taken(&reopened_warnings).is_empty());
}

fn synthetic_word(at: usize) -> String {
    let mut rest = at;
    let mut word = String::with_capacity(WORD_LETTERS);
    for position in 0..WORD_LETTERS {
        let letters = if position % 2 == 0 {
            CONSONANTS
        } else {
            VOWELS
        };
        word.push(char::from(letters[rest % letters.len()]));
        rest /= letters.len();
    }
    word
}

fn building_documents() -> Vec<Map> {
    (0..BUILD_PHRASES / WORDS_PER_DOCUMENT)
        .map(|document| {
            let words: Vec<String> = (0..WORDS_PER_DOCUMENT)
                .map(|word| synthetic_word(document * WORDS_PER_DOCUMENT + word))
                .collect();
            let mut fields = Map::new();
            fields.insert("id", Value::String(format!("w{document}")));
            fields.insert("body", Value::String(words.join(" ")));
            fields
        })
        .collect()
}

#[test]
fn query_suggestions_child_builder() {
    let Some(root) = std::env::var_os(BUILDING_CHILD) else {
        return;
    };
    let narsil = open(Path::new(&root), Some(KEY));
    let target = narsil
        .query_suggestions()
        .suggestions_index_name(INDEX, "web")
        .expect("the group is valid");
    let written = Arc::new(AtomicU64::new(0));
    narsil.on(NarsilEventKind::Write, move |event| {
        if let NarsilEvent::Write { index_name } = event
            && *index_name == target
        {
            announce(&format!("ACK {}", written.fetch_add(1, Ordering::Relaxed)));
        }
    });
    let build = narsil
        .query_suggestions()
        .build(INDEX)
        .expect("the child's build runs");
    announce(&format!("BUILT {}", build.status.as_str()));
}

#[test]
fn a_kill_during_a_build_leaves_suggestions_that_the_next_build_completes() {
    let scratch = ScratchDirectory::new("suggestions-build-crash");
    let root = scratch.path();
    let narsil = open(root, Some(KEY));
    narsil
        .create_index(INDEX, body_index())
        .expect("the index is created");
    let written = narsil
        .insert_batch(INDEX, building_documents())
        .expect("the corpus is written");
    assert!(written.failed.is_empty());
    let suggestions = narsil.query_suggestions();
    suggestions
        .update_setting(
            INDEX,
            &QuerySuggestionsSetting {
                max_phrases_per_person: Some(PHRASES_PER_PERSON as u32),
                max_people_per_day: Some(PEOPLE_PER_DAY),
                ..setting(2, 1)
            },
        )
        .expect("the feature turns on");
    for at in 0..BUILD_PHRASES {
        let phrase = synthetic_word(at);
        let first_person = 2 * (at / PHRASES_PER_PERSON);
        for person in [first_person, first_person + 1] {
            let result = suggestions
                .record_query(INDEX, &search(&phrase, &format!("builder-{person}"), "web"))
                .expect("the search is counted");
            assert_eq!(result.outcome, RecordQueryOutcome::Recorded, "{phrase}");
        }
    }
    narsil.shutdown().expect("the engine shuts down");

    killed_after(
        "query_suggestions_child_builder",
        BUILDING_CHILD,
        root,
        BUILD_ACKNOWLEDGEMENTS,
    )
    .expect("the child's build wrote suggestions");
    let narsil = open(root, Some(KEY));
    let warnings = warnings_of(&narsil);
    let partial = suggestions_of(&narsil, INDEX, "web");
    assert!(
        partial.len() < BUILD_PHRASES,
        "the kill stopped the build before it wrote every suggestion"
    );
    let expected: BTreeMap<String, (u64, String)> = (0..BUILD_PHRASES)
        .map(|at| (synthetic_word(at), (2, "popular".to_string())))
        .collect();
    let suggestions = narsil.query_suggestions();
    let finished = suggestions.build(INDEX).expect("the next build runs");
    assert_eq!(finished.status, QuerySuggestionsBuildStatus::Completed);
    assert_eq!(suggestions_of(&narsil, INDEX, "web"), expected);
    let again = suggestions.build(INDEX).expect("the build after it runs");
    assert_eq!(again.status, QuerySuggestionsBuildStatus::Skipped);
    assert!(taken(&warnings).is_empty());
}

mod support;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use narsil::{
    ErrorCode, ManualQuerySuggestion, Narsil, NarsilConfig, NarsilEvent, NarsilEventKind,
    QuerySuggestionsSetting, QuerySuggestionsWarningReason, RecordedQuery,
};
use support::ScratchDirectory;
use support::suggestions::{
    INDEX, KEY, MIN_PEOPLE, MIN_RESULTS, corpus, create_with_corpus, open, setting,
};

const CALL_ANSWER: Duration = Duration::from_secs(10);
const ONE_PHRASE_A_DAY: u32 = 1;

fn on_another_thread<T: Send + 'static>(call: impl FnOnce() -> T + Send + 'static) -> Receiver<T> {
    let (answer, answers) = channel();
    std::thread::spawn(move || {
        let _ = answer.send(call());
    });
    answers
}

fn search(query: &str) -> RecordedQuery {
    RecordedQuery {
        query: query.into(),
        person: "visitor-1@example.org".into(),
        group: "web".into(),
    }
}

fn engine_with_suggestions(
    scratch: &ScratchDirectory,
    setting: &QuerySuggestionsSetting,
) -> Arc<Narsil> {
    let narsil = Arc::new(open(scratch.path(), Some(KEY)));
    create_with_corpus(&narsil, INDEX, &corpus());
    narsil
        .query_suggestions()
        .update_setting(INDEX, setting)
        .expect("the feature turns on");
    narsil
}

#[test]
fn a_phrase_limit_listener_that_records_another_search_returns_with_the_search_that_warned() {
    let scratch = ScratchDirectory::new("listener-records-in-warning");
    let narsil = engine_with_suggestions(
        &scratch,
        &QuerySuggestionsSetting {
            max_phrases_per_day: Some(ONE_PHRASE_A_DAY),
            ..setting(MIN_PEOPLE, MIN_RESULTS)
        },
    );
    let (listener_answer, listener_answers) = channel();
    let listener_answer = Mutex::new(listener_answer);
    let listener_engine = Arc::downgrade(&narsil);
    narsil.on(NarsilEventKind::QuerySuggestionsWarning, move |event| {
        if let NarsilEvent::QuerySuggestionsWarning {
            reason: QuerySuggestionsWarningReason::PhraseLimit,
            ..
        } = event
            && let Some(engine) = listener_engine.upgrade()
        {
            let recorded = engine
                .query_suggestions()
                .record_query(INDEX, &search("amber"));
            let _ = listener_answer
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .send(recorded.is_ok());
        }
    });
    narsil
        .query_suggestions()
        .record_query(INDEX, &search("amber"))
        .expect("the first phrase of the day is counted");

    let recorder = Arc::clone(&narsil);
    let warned = on_another_thread(move || {
        recorder
            .query_suggestions()
            .record_query(INDEX, &search("copper"))
            .is_ok()
    });

    assert_eq!(
        listener_answers.recv_timeout(CALL_ANSWER).ok(),
        Some(true),
        "the listener's search returns while the warning search waits for it"
    );
    assert_eq!(
        warned.recv_timeout(CALL_ANSWER).ok(),
        Some(true),
        "the search that reached the phrase limit returns"
    );
}

#[test]
fn a_write_listener_that_drops_the_source_index_is_refused_and_the_manual_suggestion_returns() {
    let scratch = ScratchDirectory::new("listener-drops-in-suggestion-write");
    let narsil = engine_with_suggestions(&scratch, &setting(MIN_PEOPLE, MIN_RESULTS));
    let (listener_answer, listener_answers) = channel();
    let listener_answer = Mutex::new(listener_answer);
    let dropped_once = AtomicBool::new(false);
    let listener_engine = Arc::downgrade(&narsil);
    narsil.on(NarsilEventKind::Write, move |event| {
        if let NarsilEvent::Write { index_name } = event
            && index_name != INDEX
            && !dropped_once.swap(true, Ordering::AcqRel)
            && let Some(engine) = listener_engine.upgrade()
        {
            let refused = engine.drop_index(INDEX).err().map(|error| error.code());
            let _ = listener_answer
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .send(refused);
        }
    });

    let writer = Arc::clone(&narsil);
    let added = on_another_thread(move || {
        writer
            .query_suggestions()
            .add_suggestion(
                INDEX,
                &ManualQuerySuggestion {
                    group: "web".into(),
                    query: "amber".into(),
                    count: None,
                },
            )
            .is_ok()
    });

    assert_eq!(
        listener_answers.recv_timeout(CALL_ANSWER).ok(),
        Some(Some(ErrorCode::CONFIG_INVALID)),
        "the listener's drop of the index that its own thread holds is refused at once"
    );
    assert_eq!(
        added.recv_timeout(CALL_ANSWER).ok(),
        Some(true),
        "the manual suggestion returns once its listener finishes"
    );
    assert!(
        narsil.list_indexes().iter().any(|info| info.name == INDEX),
        "the refused drop leaves the source index in place"
    );
}

#[test]
fn a_restore_warning_listener_that_drops_the_restored_index_is_refused_and_the_restore_returns() {
    let scratch = ScratchDirectory::new("listener-drops-in-restore-warning");
    let source = engine_with_suggestions(&scratch, &setting(MIN_PEOPLE, MIN_RESULTS));
    let mut archive = Vec::new();
    source
        .snapshot(INDEX, &mut archive)
        .expect("the index with suggestions on is archived");

    let keyless = Arc::new(Narsil::open(NarsilConfig::default()).expect("the engine opens"));
    let (listener_answer, listener_answers) = channel();
    let listener_answer = Mutex::new(listener_answer);
    let listener_engine = Arc::downgrade(&keyless);
    keyless.on(NarsilEventKind::QuerySuggestionsWarning, move |_| {
        if let Some(engine) = listener_engine.upgrade() {
            let refused = engine.drop_index(INDEX).err().map(|error| error.code());
            let _ = listener_answer
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .send(refused);
        }
    });

    let restorer = Arc::clone(&keyless);
    let restored =
        on_another_thread(move || restorer.restore(INDEX, &mut archive.as_slice()).is_ok());

    assert_eq!(
        listener_answers.recv_timeout(CALL_ANSWER).ok(),
        Some(Some(ErrorCode::CONFIG_INVALID)),
        "the listener's drop of the name that the restore holds is refused at once"
    );
    assert_eq!(
        restored.recv_timeout(CALL_ANSWER).ok(),
        Some(true),
        "the restore returns"
    );
    assert!(
        keyless.list_indexes().iter().any(|info| info.name == INDEX),
        "the refused drop leaves the restored index in place"
    );
}

mod support;

use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use narsil::{NarsilEvent, NarsilEventKind, QuerySuggestionsBuildPhase};
use support::ScratchDirectory;
use support::suggestions::{
    INDEX, KEY, MIN_PEOPLE, MIN_RESULTS, corpus, create_with_corpus, open, setting,
};

const SHUTDOWN_ANSWER: Duration = Duration::from_secs(10);

#[test]
fn a_shutdown_inside_the_listener_of_a_starting_build_returns_and_the_build_returns_after_it() {
    let scratch = ScratchDirectory::new("suggestions-shutdown-in-build");
    let narsil = Arc::new(open(scratch.path(), Some(KEY)));
    create_with_corpus(&narsil, INDEX, &corpus());
    narsil
        .query_suggestions()
        .update_setting(INDEX, &setting(MIN_PEOPLE, MIN_RESULTS))
        .expect("the feature turns on");

    let (shutdown_answer, shutdown_answers) = channel();
    let shutdown_answer = Mutex::new(shutdown_answer);
    let listener_engine = Arc::downgrade(&narsil);
    narsil.on(NarsilEventKind::QuerySuggestionsBuild, move |event| {
        if let NarsilEvent::QuerySuggestionsBuild {
            phase: QuerySuggestionsBuildPhase::Started,
            ..
        } = event
            && let Some(engine) = listener_engine.upgrade()
        {
            let outcome = engine.shutdown();
            let _ = shutdown_answer
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .send(outcome);
        }
    });
    let (build_answer, build_answers) = channel();
    let builder = Arc::clone(&narsil);
    std::thread::spawn(move || {
        let _ = build_answer.send(builder.query_suggestions().build(INDEX).is_ok());
    });

    let shut_down = shutdown_answers.recv_timeout(SHUTDOWN_ANSWER);
    assert!(
        matches!(shut_down, Ok(Ok(()))),
        "the shutdown inside the listener returns without waiting for the build that called it"
    );
    assert!(
        build_answers.recv_timeout(SHUTDOWN_ANSWER).is_ok(),
        "the build returns once its listener finishes"
    );
    assert!(
        narsil.list_indexes().is_empty(),
        "the shut-down engine holds no index"
    );
}

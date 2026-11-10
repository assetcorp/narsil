mod support;

use narsil::{
    ErrorCode, ManualQuerySuggestion, QuerySuggestionsBuildStatus, QuerySuggestionsSetting,
    RecordQueryOutcome, SyncSetting,
};
use support::ScratchDirectory;
use support::suggestions::{
    INDEX, KEY, MIN_PEOPLE, MIN_RESULTS, corpus, counted, create_with_corpus, due, first_round,
    history_files, holds_bytes, normalised, open, person, popular, preview_of, preview_order,
    record_all, search, second_round, setting, suggestions_of, taken, warnings_of,
};

#[test]
fn an_index_with_the_feature_off_keeps_no_search_and_no_raw_person() {
    let scratch = ScratchDirectory::new("suggestions-off");
    let root = scratch.path();
    let corpus = corpus();
    let narsil = open(root, Some(KEY));
    create_with_corpus(&narsil, INDEX, &corpus);
    let refused = narsil
        .query_suggestions()
        .record_query(INDEX, &search("amber copper", &person(0), "web"))
        .expect_err("an index with the feature off counts nothing");
    assert_eq!(refused.code(), ErrorCode::QUERY_SUGGESTIONS_NOT_ENABLED);
    narsil.shutdown().expect("the engine shuts down");
    assert!(
        history_files(root, INDEX).is_empty(),
        "the engine wrote no history for an index with the feature off"
    );

    let narsil = open(root, Some(KEY));
    narsil
        .query_suggestions()
        .update_setting(INDEX, &setting(MIN_PEOPLE, MIN_RESULTS))
        .expect("the feature turns on");
    let searches = first_round();
    record_all(&narsil, &searches);
    narsil.shutdown().expect("the engine shuts down");
    let saved = history_files(root, INDEX);
    assert!(!saved.is_empty(), "a clean shutdown saves the day's counts");
    for file in support::suggestions::files_under(root) {
        let bytes = std::fs::read(&file).expect("every file reads");
        for (query, _) in &searches {
            assert!(
                !holds_bytes(&bytes, query.person.as_bytes()),
                "{} holds the raw ID {}",
                file.display(),
                query.person
            );
        }
    }

    let keyless = open(root, None);
    let without_key = keyless
        .query_suggestions()
        .record_query(INDEX, &search("amber copper", &person(9), "web"))
        .expect("an engine without a key refuses the count");
    assert_eq!(without_key.outcome, RecordQueryOutcome::NoKey);
    let enabled_without_key = keyless
        .query_suggestions()
        .update_setting(INDEX, &setting(MIN_PEOPLE, MIN_RESULTS))
        .expect_err("an engine without a key turns nothing on");
    assert_eq!(enabled_without_key.code(), ErrorCode::CONFIG_INVALID);
    let before: Vec<Vec<u8>> = saved
        .iter()
        .filter_map(|file| std::fs::read(file).ok())
        .collect();
    keyless.shutdown().expect("the engine shuts down");
    let after: Vec<Vec<u8>> = history_files(root, INDEX)
        .iter()
        .filter_map(|file| std::fs::read(file).ok())
        .collect();
    assert_eq!(
        before, after,
        "an engine without a key changes no history file"
    );

    let narsil = open(root, Some(KEY));
    narsil
        .query_suggestions()
        .update_setting(
            INDEX,
            &QuerySuggestionsSetting {
                enabled: false,
                ..setting(MIN_PEOPLE, MIN_RESULTS)
            },
        )
        .expect("the feature turns off");
    assert!(
        history_files(root, INDEX).is_empty(),
        "turning the feature off deletes the history"
    );
    let off = narsil
        .query_suggestions()
        .record_query(INDEX, &search("amber copper", &person(0), "web"))
        .expect_err("the feature is off again");
    assert_eq!(off.code(), ErrorCode::QUERY_SUGGESTIONS_NOT_ENABLED);
    narsil.shutdown().expect("the engine shuts down");
    assert!(
        history_files(root, INDEX).is_empty(),
        "the shutdown after turning the feature off saves nothing"
    );
    match open(root, Some(KEY))
        .query_suggestions()
        .preview(INDEX, None)
    {
        Ok(preview) => assert!(
            preview.entries.is_empty(),
            "no count survives turning the feature off"
        ),
        Err(error) => assert_eq!(error.code(), ErrorCode::QUERY_SUGGESTIONS_NOT_ENABLED),
    }
}

#[test]
fn a_build_publishes_exactly_the_phrases_that_enough_people_searched_and_enough_documents_match() {
    let scratch = ScratchDirectory::new("suggestions-build");
    let root = scratch.path();
    let corpus = corpus();
    let narsil = open(root, Some(KEY));
    let warnings = warnings_of(&narsil);
    create_with_corpus(&narsil, INDEX, &corpus);
    let suggestions = narsil.query_suggestions();
    suggestions
        .update_setting(INDEX, &setting(MIN_PEOPLE, MIN_RESULTS))
        .expect("the feature turns on");
    let first = first_round();
    record_all(&narsil, &first);

    let counted_once = counted(&[&first]);
    let expected = due(&counted_once, &corpus, MIN_PEOPLE, MIN_RESULTS);
    let crowded_but_unmatched = counted_once.iter().any(|((_, phrase), people)| {
        people.len() >= MIN_PEOPLE as usize
            && support::suggestions::matching_documents(phrase, &corpus) < MIN_RESULTS as usize
    });
    assert!(
        crowded_but_unmatched,
        "the oracle holds a phrase that enough people searched but too few documents match"
    );
    assert!(
        expected
            .values()
            .map(|phrases| phrases.len())
            .sum::<usize>()
            > 0
    );

    let preview = suggestions
        .preview(INDEX, Some(1_000))
        .expect("the preview reads");
    assert_eq!(preview_of(&preview.entries), preview_order(&expected));
    assert!(!preview.truncated);

    let build = suggestions.build(INDEX).expect("the build runs");
    assert_eq!(build.status, QuerySuggestionsBuildStatus::Completed);
    for group in support::suggestions::GROUPS {
        assert_eq!(
            suggestions_of(&narsil, INDEX, group),
            popular(&expected, group),
            "group {group} holds the phrases that the oracle admits"
        );
    }
    let again = suggestions.build(INDEX).expect("the second build runs");
    assert_eq!(
        again.status,
        QuerySuggestionsBuildStatus::Skipped,
        "a build with no new history skips"
    );

    let second = second_round();
    record_all(&narsil, &second);
    let grown = due(
        &counted(&[&first, &second]),
        &corpus,
        MIN_PEOPLE,
        MIN_RESULTS,
    );
    narsil.shutdown().expect("the engine shuts down");
    let narsil = open(root, Some(KEY));
    let reopened_warnings = warnings_of(&narsil);
    let rebuilt = narsil
        .query_suggestions()
        .build(INDEX)
        .expect("the build after a restart runs");
    assert_eq!(rebuilt.status, QuerySuggestionsBuildStatus::Completed);
    for group in support::suggestions::GROUPS {
        assert_eq!(
            suggestions_of(&narsil, INDEX, group),
            popular(&grown, group),
            "group {group} holds the phrases of both rounds after a restart"
        );
    }
    assert!(taken(&warnings).is_empty());
    assert!(taken(&reopened_warnings).is_empty());
}

#[test]
fn a_banned_phrase_leaves_every_suggestions_index_and_stays_out_through_a_restore() {
    let scratch = ScratchDirectory::new("suggestions-bans");
    let root = scratch.path();
    let corpus = corpus();
    let narsil = open(root, Some(KEY));
    create_with_corpus(&narsil, INDEX, &corpus);
    let suggestions = narsil.query_suggestions();
    suggestions
        .update_setting(INDEX, &setting(MIN_PEOPLE, MIN_RESULTS))
        .expect("the feature turns on");
    let first = first_round();
    record_all(&narsil, &first);
    let expected = due(&counted(&[&first]), &corpus, MIN_PEOPLE, MIN_RESULTS);
    let mut before_bans = Vec::new();
    narsil
        .snapshot(INDEX, &mut before_bans)
        .expect("the snapshot is written");
    suggestions.build(INDEX).expect("the build runs");

    let (banned_group, banned) = expected
        .iter()
        .find_map(|(group, phrases)| Some((group.clone(), phrases.keys().next()?.clone())))
        .expect("the oracle publishes a phrase");
    let stored = suggestions
        .update_bans(INDEX, &[format!("  {}  ", banned.to_uppercase())])
        .expect("the ban list is stored");
    assert_eq!(stored, vec![banned.clone()]);
    assert!(
        !suggestions_of(&narsil, INDEX, &banned_group).contains_key(&banned),
        "the ban removes the phrase before the call returns"
    );
    let refused = suggestions
        .record_query(INDEX, &search(&banned, &person(40), &banned_group))
        .expect("the banned search is refused");
    assert_eq!(refused.outcome, RecordQueryOutcome::Banned);
    let manual_refused = suggestions
        .add_suggestion(
            INDEX,
            &ManualQuerySuggestion {
                group: "app".into(),
                query: banned.clone(),
                count: Some(9),
            },
        )
        .expect_err("a banned phrase is never added by hand");
    assert_eq!(manual_refused.code(), ErrorCode::CONFIG_INVALID);

    let manual = "meadow orchid violet";
    suggestions
        .add_suggestion(
            INDEX,
            &ManualQuerySuggestion {
                group: "web".into(),
                query: manual.into(),
                count: Some(7),
            },
        )
        .expect("a manual suggestion is added");
    assert_eq!(
        suggestions_of(&narsil, INDEX, "web").get(manual),
        Some(&(7, "manual".to_string()))
    );
    let holders = suggestions
        .remove_query(INDEX, manual)
        .expect("the manual suggestion is removed");
    assert_eq!(holders, 1, "one suggestions index held the phrase");
    assert!(!suggestions_of(&narsil, INDEX, "web").contains_key(manual));

    narsil
        .restore(INDEX, &mut before_bans.as_slice())
        .expect("the snapshot from before the bans restores");
    let kept = suggestions.bans(INDEX).expect("the ban list reads");
    assert!(
        kept.contains(&banned),
        "the restore keeps the ban on {banned}"
    );
    assert!(kept.contains(&manual.to_string()));
    let later: Vec<_> = second_round()
        .into_iter()
        .map(|(query, outcome)| {
            let refused = normalised(&query.query) == banned || query.query == manual;
            (
                query,
                if refused {
                    RecordQueryOutcome::Banned
                } else {
                    outcome
                },
            )
        })
        .collect();
    record_all(&narsil, &later);
    let rebuilt = suggestions.build(INDEX).expect("the build runs");
    assert_eq!(rebuilt.status, QuerySuggestionsBuildStatus::Completed);
    for group in support::suggestions::GROUPS {
        let held = suggestions_of(&narsil, INDEX, group);
        assert!(
            !held.contains_key(&banned),
            "{group} never publishes {banned} again"
        );
        assert!(!held.contains_key(manual));
    }
}

fn close_suggestions_indexes(narsil: &narsil::Narsil) -> usize {
    let mut closed = 0;
    for group in support::suggestions::GROUPS {
        let name = narsil
            .query_suggestions()
            .suggestions_index_name(INDEX, group)
            .expect("the group is valid");
        match narsil.close_index(&name) {
            Ok(()) => closed += 1,
            Err(error) if error.code() == ErrorCode::INDEX_NOT_FOUND => {}
            Err(error) => panic!("the suggestions index closes: {error}"),
        }
    }
    closed
}

#[test]
fn a_closed_index_keeps_its_bans_its_suggestions_indexes_and_its_drop_clean_up() {
    let scratch = ScratchDirectory::new("suggestions-closed");
    let root = scratch.path();
    let corpus = corpus();
    let narsil = open(root, Some(KEY));
    create_with_corpus(&narsil, INDEX, &corpus);
    let suggestions = narsil.query_suggestions();
    suggestions
        .update_setting(INDEX, &setting(MIN_PEOPLE, MIN_RESULTS))
        .expect("the feature turns on");
    let first = first_round();
    record_all(&narsil, &first);
    let mut before_bans = Vec::new();
    narsil
        .snapshot(INDEX, &mut before_bans)
        .expect("the snapshot is written");
    suggestions.build(INDEX).expect("the build runs");
    let expected = due(&counted(&[&first]), &corpus, MIN_PEOPLE, MIN_RESULTS);
    let (banned_group, banned) = expected
        .iter()
        .find_map(|(group, phrases)| Some((group.clone(), phrases.keys().next()?.clone())))
        .expect("the oracle publishes a phrase");

    assert!(close_suggestions_indexes(&narsil) > 0);
    let holders = suggestions
        .remove_query(INDEX, &banned)
        .expect("the phrase is banned");
    assert_eq!(holders, 1, "the closed suggestions index held the phrase");
    assert!(!suggestions_of(&narsil, INDEX, &banned_group).contains_key(&banned));

    let later: Vec<_> = second_round()
        .into_iter()
        .map(|(query, outcome)| {
            let refused = normalised(&query.query) == banned;
            (
                query,
                if refused {
                    RecordQueryOutcome::Banned
                } else {
                    outcome
                },
            )
        })
        .collect();
    record_all(&narsil, &later);
    assert!(close_suggestions_indexes(&narsil) > 0);
    let rebuilt = suggestions
        .build(INDEX)
        .expect("a build writes into closed suggestions indexes");
    assert_eq!(rebuilt.status, QuerySuggestionsBuildStatus::Completed);
    let after = due(
        &counted(&[&first, &later]),
        &corpus,
        MIN_PEOPLE,
        MIN_RESULTS,
    );
    for group in support::suggestions::GROUPS {
        let mut published = popular(&after, group);
        published.remove(&banned);
        assert_eq!(suggestions_of(&narsil, INDEX, group), published, "{group}");
    }

    narsil.close_index(INDEX).expect("the source index closes");
    narsil
        .restore(INDEX, &mut before_bans.as_slice())
        .expect("the snapshot from before the ban restores over the closed index");
    assert_eq!(
        suggestions.bans(INDEX).expect("the ban list reads"),
        vec![banned.clone()]
    );
    let refused = suggestions
        .record_query(INDEX, &search(&banned, &person(41), &banned_group))
        .expect("the banned search is refused");
    assert_eq!(refused.outcome, RecordQueryOutcome::Banned);

    assert!(close_suggestions_indexes(&narsil) > 0);
    narsil.drop_index(INDEX).expect("the source index drops");
    let left: Vec<String> = narsil
        .list_indexes()
        .into_iter()
        .map(|index| index.name)
        .collect();
    assert!(left.is_empty(), "the drop leaves {left:?} behind");
}

#[test]
fn an_index_never_holds_device_sync_and_popular_query_suggestions_at_once() {
    let scratch = ScratchDirectory::new("suggestions-sync");
    let root = scratch.path();
    let corpus = corpus();
    let narsil = open(root, Some(KEY));
    let suggesting = "suggesting";
    create_with_corpus(&narsil, INDEX, &corpus);
    create_with_corpus(&narsil, suggesting, &corpus);
    let suggestions = narsil.query_suggestions();
    let sync_on = SyncSetting {
        enabled: true,
        ..SyncSetting::default()
    };
    narsil.update_sync(INDEX, &sync_on).expect("sync turns on");
    let refused = suggestions
        .update_setting(INDEX, &setting(MIN_PEOPLE, MIN_RESULTS))
        .expect_err("a synced index takes no suggestions");
    assert_eq!(refused.code(), ErrorCode::CONFIG_INVALID);

    suggestions
        .update_setting(suggesting, &setting(MIN_PEOPLE, MIN_RESULTS))
        .expect("the feature turns on");
    let refused = narsil
        .update_sync(suggesting, &sync_on)
        .expect_err("an index with suggestions never syncs");
    assert_eq!(refused.code(), ErrorCode::CONFIG_INVALID);

    let mut with_suggestions = Vec::new();
    narsil
        .snapshot(suggesting, &mut with_suggestions)
        .expect("the snapshot is written");
    for closed in [false, true] {
        if closed {
            narsil.close_index(INDEX).expect("the synced index closes");
        }
        let refused = narsil
            .restore(INDEX, &mut with_suggestions.as_slice())
            .expect_err("a restore never turns suggestions on over a synced index");
        assert_eq!(
            refused.code(),
            ErrorCode::CONFIG_INVALID,
            "closed: {closed}"
        );
        assert!(
            narsil
                .get_sync(INDEX)
                .expect("the sync state reads")
                .enabled
        );
        let off = suggestions
            .status(INDEX)
            .expect("the status reads")
            .setting
            .is_none_or(|setting| !setting.enabled);
        assert!(off, "closed: {closed}");
    }
}

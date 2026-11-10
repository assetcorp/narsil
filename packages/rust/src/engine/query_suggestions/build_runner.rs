use std::collections::HashMap;
use std::sync::{Condvar, Mutex};

use super::build::run_build;
use super::build_record::{BuildRecord, new_build_id};
use super::constants::SOURCES_DIGEST_BYTES;
use super::host::{locked, read_build_record, warn_of_failure, write_build_record};
use super::types::{
    QuerySuggestionsBuild, QuerySuggestionsBuildPhase, QuerySuggestionsBuildStatus,
    QuerySuggestionsBuildTrigger, QuerySuggestionsWarningReason,
};
use crate::durability::platform::now_ms;
use crate::engine::events::NarsilEvent;
use crate::engine::{EngineInner, Narsil};
use crate::error::Result;
use crate::format::metadata_parts::config_invalid;

#[derive(Default)]
pub(crate) struct BuildRunner {
    running: Mutex<HashMap<String, QuerySuggestionsBuild>>,
    finished: Mutex<HashMap<String, QuerySuggestionsBuild>>,
    settled: Condvar,
}

fn emit_phase(engine: &EngineInner, index_name: &str, build: &QuerySuggestionsBuild) {
    let phase = match build.status {
        QuerySuggestionsBuildStatus::Running => QuerySuggestionsBuildPhase::Started,
        QuerySuggestionsBuildStatus::Completed => QuerySuggestionsBuildPhase::Completed,
        QuerySuggestionsBuildStatus::Failed => QuerySuggestionsBuildPhase::Failed,
        QuerySuggestionsBuildStatus::Skipped => QuerySuggestionsBuildPhase::Skipped,
    };
    engine.events.emit(NarsilEvent::QuerySuggestionsBuild {
        index_name: index_name.to_string(),
        build_id: build.build_id.clone(),
        phase,
        trigger: build.trigger,
        published: build.published,
        removed: build.removed,
        discarded: build.discarded,
        error_code: build.error_code.clone(),
    });
}

fn new_build(
    trigger: QuerySuggestionsBuildTrigger,
    status: QuerySuggestionsBuildStatus,
) -> Result<QuerySuggestionsBuild> {
    Ok(QuerySuggestionsBuild {
        build_id: new_build_id()?,
        trigger,
        status,
        started_at: now_ms(),
        ended_at: None,
        published: 0,
        removed: 0,
        discarded: 0,
        error_code: None,
    })
}

pub(crate) fn ended_as_planned(build: &QuerySuggestionsBuild) -> bool {
    matches!(
        build.status,
        QuerySuggestionsBuildStatus::Completed | QuerySuggestionsBuildStatus::Skipped
    )
}

impl BuildRunner {
    pub(crate) fn last_build(
        &self,
        engine: &EngineInner,
        index_name: &str,
    ) -> Option<QuerySuggestionsBuild> {
        if let Some(build) = locked(&self.running).get(index_name) {
            return Some(build.clone());
        }
        if let Some(build) = locked(&self.finished).get(index_name) {
            return Some(build.clone());
        }
        read_build_record(engine, index_name).map(|record| record.build)
    }

    pub(crate) fn settle(&self) {
        let mut running = locked(&self.running);
        while !running.is_empty() {
            running = self
                .settled
                .wait(running)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }

    pub(crate) fn forget(&self, index_name: &str) {
        locked(&self.finished).remove(index_name);
    }

    pub(crate) fn start(
        &self,
        narsil: &Narsil,
        index_name: &str,
        trigger: QuerySuggestionsBuildTrigger,
    ) -> Result<QuerySuggestionsBuild> {
        let engine = &*narsil.inner;
        let runtime = &engine.suggestions;
        let setting = runtime.enabled_setting(engine, index_name)?;
        if runtime.scrambler().is_none() {
            return Err(config_invalid(
                "This engine has no query suggestions key, so it builds no suggestions",
            ));
        }
        runtime.guard_stopping()?;
        let build = {
            let mut running = locked(&self.running);
            if running.contains_key(index_name) {
                drop(running);
                let mut skipped = new_build(trigger, QuerySuggestionsBuildStatus::Skipped)?;
                skipped.ended_at = Some(skipped.started_at);
                emit_phase(engine, index_name, &skipped);
                return Ok(skipped);
            }
            let build = new_build(trigger, QuerySuggestionsBuildStatus::Running)?;
            running.insert(index_name.to_string(), build.clone());
            build
        };
        emit_phase(engine, index_name, &build);
        let last_completed =
            read_build_record(engine, index_name).filter(|record| ended_as_planned(&record.build));
        let started_at = i64::try_from(build.started_at).unwrap_or(i64::MAX);
        let outcome = run_build(
            narsil,
            index_name,
            &setting,
            last_completed.as_ref(),
            started_at,
        );
        let mut finished = build;
        finished.ended_at = Some(now_ms());
        let sources_digest = match outcome {
            Ok(outcome) => {
                finished.status = outcome.status;
                finished.published = outcome.published;
                finished.removed = outcome.removed;
                finished.discarded = outcome.discarded;
                outcome.sources_digest
            }
            Err(error) => {
                finished.status = QuerySuggestionsBuildStatus::Failed;
                finished.error_code = Some(error.code().as_str().to_string());
                [0; SOURCES_DIGEST_BYTES]
            }
        };
        let record = BuildRecord {
            build: finished,
            sources_digest,
        };
        if let Err(error) = write_build_record(engine, index_name, &record) {
            let reason = QuerySuggestionsWarningReason::SaveFailed;
            warn_of_failure(engine, index_name, reason, &error);
        }
        let finished = record.build;
        locked(&self.finished).insert(index_name.to_string(), finished.clone());
        {
            let mut running = locked(&self.running);
            running.remove(index_name);
            self.settled.notify_all();
        }
        emit_phase(engine, index_name, &finished);
        Ok(finished)
    }
}

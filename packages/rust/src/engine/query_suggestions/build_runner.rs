use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::thread::{self, ThreadId};

use super::build::run_build;
use super::build_record::{BuildRecord, new_build_id};
use super::constants::SOURCES_DIGEST_BYTES;
use super::host::{SuggestionsHost, SuggestionsOwner, locked, warn_of_failure};
use super::runtime::SuggestionsRuntime;
use super::setting::ResolvedSetting;
use super::types::{
    QuerySuggestionsBuild, QuerySuggestionsBuildPhase, QuerySuggestionsBuildStatus,
    QuerySuggestionsBuildTrigger, QuerySuggestionsWarningReason,
};
use crate::durability::platform::now_ms;
use crate::engine::events::NarsilEvent;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::metadata_parts::config_invalid;

struct RunningBuild {
    build: QuerySuggestionsBuild,
    thread: ThreadId,
}

enum Registered {
    Skipped(QuerySuggestionsBuild),
    Running(QuerySuggestionsBuild, ResolvedSetting),
}

struct RegisteredRun<'a> {
    index_name: &'a str,
    build: QuerySuggestionsBuild,
    setting: ResolvedSetting,
}

#[derive(Default)]
pub(crate) struct BuildRunner {
    running: Mutex<HashMap<String, RunningBuild>>,
    finished: Mutex<HashMap<String, QuerySuggestionsBuild>>,
    settled: Condvar,
}

fn emit_phase(host: &dyn SuggestionsHost, index_name: &str, build: &QuerySuggestionsBuild) {
    let phase = match build.status {
        QuerySuggestionsBuildStatus::Running => QuerySuggestionsBuildPhase::Started,
        QuerySuggestionsBuildStatus::Completed => QuerySuggestionsBuildPhase::Completed,
        QuerySuggestionsBuildStatus::Failed => QuerySuggestionsBuildPhase::Failed,
        QuerySuggestionsBuildStatus::Skipped => QuerySuggestionsBuildPhase::Skipped,
    };
    host.emit(NarsilEvent::QuerySuggestionsBuild {
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
        host: &dyn SuggestionsHost,
        index_name: &str,
    ) -> Option<QuerySuggestionsBuild> {
        if let Some(running) = locked(&self.running).get(index_name) {
            return Some(running.build.clone());
        }
        if let Some(build) = locked(&self.finished).get(index_name) {
            return Some(build.clone());
        }
        host.read_build_record(index_name)
            .map(|record| record.build)
    }

    pub(crate) fn settle(&self) {
        let caller = thread::current().id();
        let mut running = locked(&self.running);
        while running.values().any(|build| build.thread != caller) {
            running = self
                .settled
                .wait(running)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }

    pub(crate) fn forget(&self, index_name: &str) {
        locked(&self.finished).remove(index_name);
    }

    fn register(
        &self,
        runtime: &SuggestionsRuntime,
        host: &dyn SuggestionsHost,
        index_name: &str,
        trigger: QuerySuggestionsBuildTrigger,
    ) -> Result<Registered> {
        let setting = runtime.enabled_setting(host, index_name)?;
        if runtime.scrambler().is_none() {
            return Err(config_invalid(
                "This engine has no query suggestions key, so it builds no suggestions",
            )
            .with_details([("indexName", crate::value::Value::from(index_name))]));
        }
        runtime.guard_stopping()?;
        let mut running = locked(&self.running);
        if running.contains_key(index_name) {
            drop(running);
            let mut skipped = new_build(trigger, QuerySuggestionsBuildStatus::Skipped)?;
            skipped.ended_at = Some(skipped.started_at);
            emit_phase(host, index_name, &skipped);
            return Ok(Registered::Skipped(skipped));
        }
        let build = new_build(trigger, QuerySuggestionsBuildStatus::Running)?;
        running.insert(
            index_name.to_string(),
            RunningBuild {
                build: build.clone(),
                thread: thread::current().id(),
            },
        );
        Ok(Registered::Running(build, setting))
    }

    pub(crate) fn start(
        &self,
        runtime: &SuggestionsRuntime,
        host: &dyn SuggestionsHost,
        index_name: &str,
        trigger: QuerySuggestionsBuildTrigger,
    ) -> Result<QuerySuggestionsBuild> {
        match self.register(runtime, host, index_name, trigger)? {
            Registered::Skipped(skipped) => Ok(skipped),
            Registered::Running(build, setting) => {
                let run = RegisteredRun {
                    index_name,
                    build,
                    setting,
                };
                Ok(self.run(runtime, host, run, &|| {}))
            }
        }
    }

    pub(crate) fn begin(
        &self,
        owner: &Arc<dyn SuggestionsOwner>,
        index_name: &str,
        trigger: QuerySuggestionsBuildTrigger,
    ) -> Result<QuerySuggestionsBuild> {
        let (build, setting) =
            match self.register(owner.runtime(), owner.host(), index_name, trigger)? {
                Registered::Skipped(skipped) => return Ok(skipped),
                Registered::Running(build, setting) => (build, setting),
            };
        let (started, on_started) = mpsc::sync_channel::<()>(1);
        let worker = Arc::clone(owner);
        let name = index_name.to_string();
        let running = build.clone();
        let spawned = thread::Builder::new()
            .name("narsil-query-suggestions-build".to_string())
            .spawn(move || {
                let run = RegisteredRun {
                    index_name: &name,
                    build: running,
                    setting,
                };
                let runtime = worker.runtime();
                let mark_started = || {
                    let _ = started.try_send(());
                };
                runtime
                    .builds
                    .run(runtime, worker.host(), run, &mark_started);
                mark_started();
            });
        match spawned {
            Ok(handle) => {
                if let Some(entry) = locked(&self.running).get_mut(index_name)
                    && entry.build.build_id == build.build_id
                {
                    entry.thread = handle.thread().id();
                }
                let _ = on_started.recv();
                Ok(build)
            }
            Err(error) => {
                locked(&self.running).remove(index_name);
                self.settled.notify_all();
                Err(NarsilError::new(
                    ErrorCode::WORKER_ACTION_FAILED,
                    format!("The engine could not start a thread for the build: {error}"),
                ))
            }
        }
    }

    fn run(
        &self,
        runtime: &SuggestionsRuntime,
        host: &dyn SuggestionsHost,
        run: RegisteredRun<'_>,
        mark_started: &dyn Fn(),
    ) -> QuerySuggestionsBuild {
        let RegisteredRun {
            index_name,
            build,
            setting,
        } = run;
        emit_phase(host, index_name, &build);
        let last_completed = host
            .read_build_record(index_name)
            .filter(|record| ended_as_planned(&record.build));
        let started_at = i64::try_from(build.started_at).unwrap_or(i64::MAX);
        let outcome = (|| {
            if host.clustered() {
                let running = BuildRecord {
                    build: build.clone(),
                    sources_digest: [0; SOURCES_DIGEST_BYTES],
                };
                host.write_build_record(index_name, &running)?;
            }
            mark_started();
            run_build(
                runtime,
                host,
                index_name,
                &setting,
                last_completed.as_ref(),
                started_at,
            )
        })();
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
                finished.error_code = Some(error.spec_code().to_string());
                [0; SOURCES_DIGEST_BYTES]
            }
        };
        let record = BuildRecord {
            build: finished,
            sources_digest,
        };
        if let Err(error) = host.write_build_record(index_name, &record) {
            let reason = QuerySuggestionsWarningReason::SaveFailed;
            warn_of_failure(host, index_name, reason, &error);
        }
        let finished = record.build;
        locked(&self.finished).insert(index_name.to_string(), finished.clone());
        {
            let mut running = locked(&self.running);
            running.remove(index_name);
            self.settled.notify_all();
        }
        emit_phase(host, index_name, &finished);
        finished
    }
}

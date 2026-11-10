use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use jiff::tz::TimeZone;

use super::build_runner::ended_as_planned;
use super::constants::{DAY_MS, HISTORY_SWEEP_INTERVAL_MS, MAX_TIMER_WAIT_MS, SCHEDULE_OFF};
use super::day_store::{cutoff_day, day_of};
use super::history_files::{history_files_of, remove_history_folder};
use super::host::{locked, read_build_record, suggestion_state_of, suggestion_states, wall_ms};
use super::schedule::{
    Schedule, latest_match_at_or_before, next_match_after, parse_schedule, time_zone_named,
};
use super::types::QuerySuggestionsBuildTrigger;
use crate::engine::{EngineInner, Narsil};

#[derive(Default)]
struct TimerState {
    stopped: bool,
    saves: HashMap<String, (Instant, Duration)>,
    schedules: HashMap<String, i64>,
}

#[derive(Default)]
pub(crate) struct Timers {
    signal: Arc<(Mutex<TimerState>, Condvar)>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

fn next_midnight(now: i64) -> i64 {
    (now.div_euclid(DAY_MS) + 1).saturating_mul(DAY_MS)
}

fn schedule_of(engine: &EngineInner, index_name: &str) -> Option<(Schedule, TimeZone)> {
    let state = suggestion_state_of(engine, index_name)?;
    let resolved = state
        .setting
        .as_ref()
        .filter(|setting| setting.enabled)?
        .resolve();
    if resolved.schedule == SCHEDULE_OFF {
        return None;
    }
    Some((
        parse_schedule(&resolved.schedule)?,
        time_zone_named(&resolved.time_zone)?,
    ))
}

pub(crate) fn next_build_at(engine: &EngineInner, index_name: &str, after_ms: i64) -> Option<i64> {
    engine.suggestions.scrambler()?;
    let (schedule, zone) = schedule_of(engine, index_name)?;
    next_match_after(&schedule, &zone, after_ms)
}

fn spawn_build(engine: &Arc<EngineInner>, index_name: &str, trigger: QuerySuggestionsBuildTrigger) {
    let narsil = Narsil {
        inner: Arc::clone(engine),
    };
    let index_name = index_name.to_string();
    let _ = std::thread::Builder::new()
        .name("narsil-query-suggestions-build".to_string())
        .spawn(move || {
            let builds = &narsil.inner.suggestions.builds;
            let _ = builds.start(&narsil, &index_name, trigger);
        });
}

fn start_missed_build(engine: &Arc<EngineInner>, index_name: &str) {
    let Some((schedule, zone)) = schedule_of(engine, index_name) else {
        return;
    };
    let Some(latest) = latest_match_at_or_before(&schedule, &zone, wall_ms()) else {
        return;
    };
    let completed_since = read_build_record(engine, index_name).is_some_and(|record| {
        ended_as_planned(&record.build)
            && i64::try_from(record.build.started_at).is_ok_and(|started| started >= latest)
    });
    if !completed_since {
        spawn_build(engine, index_name, QuerySuggestionsBuildTrigger::Missed);
    }
}

pub(crate) fn sweep_now(engine: &EngineInner) {
    let files = engine.suggestions.files(engine);
    let now = wall_ms();
    for (name, state) in suggestion_states(engine) {
        let Some(setting) = state.setting.as_ref().filter(|setting| setting.enabled) else {
            if state.source.is_none() {
                let _ = remove_history_folder(files, &name);
            }
            continue;
        };
        let cutoff = cutoff_day(now, setting.resolve().retention_days);
        let Ok(listed) = history_files_of(files, &name) else {
            continue;
        };
        for file in listed.into_iter().filter(|file| file.day < cutoff) {
            let _ = files.remove(&file.key);
        }
    }
}

fn run_due(
    engine: &Arc<EngineInner>,
    due_saves: Vec<(String, Duration)>,
    due_builds: Vec<String>,
    day_ended: bool,
) {
    let runtime = &engine.suggestions;
    for (index_name, interval) in due_saves {
        runtime.save_day(engine, &index_name);
        if runtime.days.has_unsaved(&index_name) {
            runtime.timers.save_soon(&index_name, interval);
        }
    }
    for index_name in due_builds {
        spawn_build(engine, &index_name, QuerySuggestionsBuildTrigger::Schedule);
        runtime.timers.rearm(engine, &index_name);
    }
    if day_ended {
        runtime.retire_days(engine, &day_of(wall_ms()));
    }
}

fn run_timers(engine: Weak<EngineInner>, signal: Arc<(Mutex<TimerState>, Condvar)>) {
    let sweep_every = Duration::from_millis(HISTORY_SWEEP_INTERVAL_MS);
    let mut next_sweep = Instant::now() + sweep_every;
    let mut midnight = next_midnight(wall_ms());
    loop {
        let (lock, wake) = &*signal;
        let mut state = locked(lock);
        let (due_saves, due_builds) = loop {
            if state.stopped {
                return;
            }
            let now = Instant::now();
            let wall = wall_ms();
            let mut saves = Vec::new();
            state.saves.retain(|name, (at, every)| {
                let due = *at <= now;
                if due {
                    saves.push((name.clone(), *every));
                }
                !due
            });
            let mut builds = Vec::new();
            state.schedules.retain(|name, at| {
                let due = *at <= wall;
                if due {
                    builds.push(name.clone());
                }
                !due
            });
            if !saves.is_empty() || !builds.is_empty() || wall >= midnight || now >= next_sweep {
                break (saves, builds);
            }
            let until = |at: i64| Duration::from_millis(u64::try_from(at - wall).unwrap_or(0));
            let wait = state
                .saves
                .values()
                .map(|(at, _)| at.saturating_duration_since(now))
                .chain(state.schedules.values().map(|at| until(*at)))
                .chain([until(midnight), next_sweep - now])
                .fold(Duration::from_millis(MAX_TIMER_WAIT_MS), Duration::min);
            state = wake
                .wait_timeout(state, wait)
                .map(|(state, _)| state)
                .unwrap_or_else(|poisoned| poisoned.into_inner().0);
        };
        drop(state);
        let day_ended = wall_ms() >= midnight;
        if day_ended {
            midnight = next_midnight(wall_ms());
        }
        let swept = Instant::now() >= next_sweep;
        if swept {
            next_sweep = Instant::now() + sweep_every;
        }
        let Some(engine) = engine.upgrade() else {
            return;
        };
        run_due(&engine, due_saves, due_builds, day_ended);
        if swept {
            sweep_now(&engine);
        }
    }
}

impl Timers {
    pub(crate) fn start(&self, engine: &Arc<EngineInner>) {
        for (name, state) in suggestion_states(engine) {
            if state.enabled() {
                start_missed_build(engine, &name);
                self.rearm(engine, &name);
            }
        }
        let weak = Arc::downgrade(engine);
        let signal = Arc::clone(&self.signal);
        let spawned = std::thread::Builder::new()
            .name("narsil-query-suggestions".to_string())
            .spawn(move || run_timers(weak, signal));
        if let Ok(handle) = spawned {
            *locked(&self.thread) = Some(handle);
        }
    }

    fn change(&self, apply: impl FnOnce(&mut TimerState)) {
        let (lock, wake) = &*self.signal;
        let mut state = locked(lock);
        if state.stopped {
            return;
        }
        apply(&mut state);
        wake.notify_all();
    }

    pub(crate) fn save_soon(&self, index_name: &str, interval: Duration) {
        self.change(|state| {
            state
                .saves
                .entry(index_name.to_string())
                .or_insert_with(|| (Instant::now() + interval, interval));
        });
    }

    pub(crate) fn forget_save(&self, index_name: &str) {
        self.change(|state| {
            state.saves.remove(index_name);
        });
    }

    pub(crate) fn forget_index(&self, index_name: &str) {
        self.change(|state| {
            state.saves.remove(index_name);
            state.schedules.remove(index_name);
        });
    }

    pub(crate) fn rearm(&self, engine: &EngineInner, index_name: &str) {
        let next = next_build_at(engine, index_name, wall_ms());
        self.change(|state| match next {
            Some(at) => {
                state.schedules.insert(index_name.to_string(), at);
            }
            None => {
                state.schedules.remove(index_name);
            }
        });
    }

    pub(crate) fn stop(&self) {
        {
            let (lock, wake) = &*self.signal;
            let mut state = locked(lock);
            state.stopped = true;
            state.saves.clear();
            state.schedules.clear();
            wake.notify_all();
        }
        let handle = locked(&self.thread).take();
        if let Some(handle) = handle
            && handle.thread().id() != std::thread::current().id()
        {
            let _ = handle.join();
        }
    }
}

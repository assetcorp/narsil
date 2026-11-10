mod placement;

use std::sync::atomic::Ordering;
use std::sync::{Arc, MutexGuard};

use crate::error::Result;

use super::calibration::{calibrate_before_build, recalibrate_when_drifted};
use super::constants::{
    BUILD_CHUNK_VECTORS, BUILD_CHUNKS_PER_THREAD, MAX_LAYER_CAP, PARALLEL_BUILD_MIN_VECTORS,
};
use super::disk::release_pending_locations;
use super::field::{Shared, Writer};
use super::graph::{GraphTables, upper_words_of};
use super::writes::compacted_buffer;
use placement::{adopt, place_batch, publish_grown};

pub(crate) use placement::connect_unreached;

const GOLDEN_GAMMA: u32 = 0x9e37_79b9;
const FIRST_MIX_MULTIPLIER: u32 = 0x21f0_aaad;
const SECOND_MIX_MULTIPLIER: u32 = 0x735a_2d97;
const TWO_TO_THE_32: f64 = 4_294_967_296.0;
const HALF_A_STEP: f64 = 0.5;
const MAX_IDLE_BUILD_STEPS: u32 = 2;

pub(crate) struct BuildJob {
    pub(crate) graph: Option<Arc<GraphTables>>,
    pub(crate) fresh: bool,
}

pub(crate) struct Plan {
    graph: Arc<GraphTables>,
    source: Option<Arc<GraphTables>>,
    order: Vec<u32>,
    fresh: bool,
}

fn mixed(value: u32) -> u32 {
    let mut mixed = value.wrapping_add(GOLDEN_GAMMA);
    mixed ^= mixed >> 16;
    mixed = mixed.wrapping_mul(FIRST_MIX_MULTIPLIER);
    mixed ^= mixed >> 15;
    mixed = mixed.wrapping_mul(SECOND_MIX_MULTIPLIER);
    mixed ^= mixed >> 15;
    mixed
}

pub(crate) fn level_of(ordinal: u32, m: u32) -> u8 {
    let draw = (f64::from(mixed(ordinal)) + HALF_A_STEP) / TWO_TO_THE_32;
    let scale = 1.0 / f64::from(m).ln();
    let level = (-draw.ln() * scale).floor();
    if level.is_nan() || level <= 0.0 {
        return 0;
    }
    level.min(f64::from(MAX_LAYER_CAP)) as u8
}

pub(crate) fn shuffle(items: &mut [u32]) {
    let mut stream = items.len() as u32;
    for i in (1..items.len()).rev() {
        stream = mixed(stream);
        let j = ((f64::from(stream) / TWO_TO_THE_32) * (i + 1) as f64).floor() as usize;
        items.swap(i, j.min(i));
    }
}

fn lock_flag(shared: &Shared) -> MutexGuard<'_, bool> {
    shared
        .background
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn lock_gate(shared: &Shared) -> MutexGuard<'_, ()> {
    shared
        .build_gate
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn shuffled_rebuild_due(shared: &Shared, graph: &GraphTables, held: u64) -> bool {
    if graph.is_empty() || held == 0 {
        return false;
    }
    match shared.history.shuffled_build_count() {
        None => true,
        Some(_) => {
            shared.settings.bits() != 0
                && held >= shared.history.next_drift_check_at.load(Ordering::Acquire)
        }
    }
}

fn build_due(shared: &Shared) -> bool {
    if shared.restoring.load(Ordering::Acquire) || shared.is_cold() {
        return false;
    }
    let generation = shared.current();
    let live = generation.counts.live();
    if live == 0 {
        return false;
    }
    match &generation.graph {
        None => live >= shared.settings.promotion_threshold,
        Some(graph) => {
            generation.buffer.len() > 0 || shuffled_rebuild_due(shared, graph, graph.size())
        }
    }
}

pub(crate) fn schedule_build(shared: &Arc<Shared>) {
    if shared.disposed.load(Ordering::Acquire) || !build_due(shared) {
        return;
    }
    {
        let mut running = lock_flag(shared);
        if *running {
            return;
        }
        *running = true;
    }
    let held = Arc::clone(shared);
    let spawned = std::thread::Builder::new()
        .name("narsil-vector-build".to_string())
        .spawn(move || build_in_background(&held));
    if spawned.is_err() {
        stop_running(shared);
    }
}

fn stop_running(shared: &Shared) {
    *lock_flag(shared) = false;
    shared.background_done.notify_all();
}

fn build_in_background(shared: &Shared) {
    let mut idle_steps = 0;
    while !shared.disposed.load(Ordering::Acquire) {
        let built = {
            let _gate = lock_gate(shared);
            build_step(shared)
        };
        if matches!(built, Ok(true)) {
            idle_steps = 0;
            continue;
        }
        idle_steps += 1;
        let running = lock_flag(shared);
        if built.is_ok()
            && idle_steps < MAX_IDLE_BUILD_STEPS
            && !shared.disposed.load(Ordering::Acquire)
            && build_due(shared)
        {
            drop(running);
            continue;
        }
        drop(running);
        break;
    }
    stop_running(shared);
}

pub(crate) fn wait_for_builds(shared: &Shared) {
    let mut running = lock_flag(shared);
    while *running {
        running = shared
            .background_done
            .wait(running)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
    }
}

pub(crate) fn building(shared: &Shared) -> bool {
    *lock_flag(shared)
}

fn build_step(shared: &Shared) -> Result<bool> {
    let plan = {
        let mut writer = shared.lock_writer();
        plan_background_build(shared, &mut writer)?
    };
    match plan {
        Some(plan) => carry_out(shared, plan),
        None => Ok(false),
    }
}

fn plan_background_build(shared: &Shared, writer: &mut Writer) -> Result<Option<Plan>> {
    let generation = Arc::clone(&writer.generation);
    let live = generation.counts.live();
    if live == 0 || writer.holds_publication {
        return Ok(None);
    }
    let Some(graph) = generation.graph.clone() else {
        if live < shared.settings.promotion_threshold || !calibrate_before_build(shared, writer)? {
            return Ok(None);
        }
        return Ok(Some(fresh_plan(shared, writer)));
    };
    if shuffled_rebuild_due(shared, &graph, graph.size()) {
        let recalibrated = if shared.history.shuffled_build_count().is_none() {
            calibrate_before_build(shared, writer)?
        } else {
            recalibrate_when_drifted(shared, writer, graph.size())?
        };
        if recalibrated {
            return Ok(Some(fresh_plan(shared, writer)));
        }
    }
    if writer.generation.buffer.len() == 0 {
        return Ok(None);
    }
    if shared.settings.bits() != 0
        && !writer.generation.store.calibrated()
        && !calibrate_before_build(shared, writer)?
    {
        return Ok(None);
    }
    let current = Arc::clone(&writer.generation);
    let order: Vec<u32> = current
        .buffer
        .ordinals()
        .filter(|&ordinal| current.is_buffered(ordinal) && current.store.is_live(ordinal))
        .collect();
    if order.is_empty() {
        let lacking = compacted_buffer(&current);
        shared.publish(
            writer,
            current.with(|parts| parts.buffer = Arc::new(lacking)),
        );
        return Ok(None);
    }
    Ok(Some(grow_plan(writer, graph, order)))
}

pub(crate) fn grow_plan(writer: &mut Writer, source: Arc<GraphTables>, order: Vec<u32>) -> Plan {
    let graph = Arc::new(source.copied(source.slot_capacity(), source.upper_capacity()));
    writer.job = Some(BuildJob {
        graph: Some(Arc::clone(&graph)),
        fresh: false,
    });
    Plan {
        graph,
        source: Some(source),
        order,
        fresh: false,
    }
}

pub(crate) fn fresh_plan(shared: &Shared, writer: &mut Writer) -> Plan {
    let generation = &writer.generation;
    let mut order = generation.live_ordinals();
    shuffle(&mut order);
    let settings = &shared.settings;
    let upper: usize = order
        .iter()
        .map(|&ordinal| upper_words_of(settings.m, level_of(ordinal, settings.m)))
        .sum();
    let graph = Arc::new(GraphTables::new(
        settings.m,
        settings.ef_construction,
        settings.metric_code(),
        generation.store.slots() as usize,
        upper,
    ));
    writer.job = Some(BuildJob {
        graph: Some(Arc::clone(&graph)),
        fresh: true,
    });
    Plan {
        graph,
        source: None,
        order,
        fresh: true,
    }
}

fn threads_for(count: usize) -> usize {
    if (count as u64) < PARALLEL_BUILD_MIN_VECTORS {
        return 1;
    }
    std::thread::available_parallelism().map_or(1, usize::from)
}

fn still_current(writer: &Writer, plan: &Plan) -> bool {
    let job_holds = writer
        .job
        .as_ref()
        .filter(|job| job.fresh == plan.fresh)
        .and_then(|job| job.graph.as_ref())
        .is_some_and(|graph| Arc::ptr_eq(graph, &plan.graph));
    let source_published = plan.source.as_ref().is_none_or(|source| {
        writer
            .generation
            .graph
            .as_ref()
            .is_some_and(|graph| Arc::ptr_eq(graph, source))
    });
    job_holds && source_published
}

pub(crate) fn carry_out(shared: &Shared, mut plan: Plan) -> Result<bool> {
    let threads = threads_for(plan.order.len());
    let batch = threads * BUILD_CHUNKS_PER_THREAD * BUILD_CHUNK_VECTORS;
    let order = std::mem::take(&mut plan.order);
    for ordinals in order.chunks(batch.max(1)) {
        if shared.disposed.load(Ordering::Acquire) {
            abandon(shared, &plan);
            return Ok(false);
        }
        match place_batch(shared, &mut plan, ordinals, threads) {
            Ok(true) => {}
            Ok(false) => return Ok(false),
            Err(error) => {
                abandon(shared, &plan);
                return Err(error);
            }
        }
    }
    let mut writer = shared.lock_writer();
    if !still_current(&writer, &plan) {
        return Ok(false);
    }
    if let Err(error) = connect_unreached(&writer, &plan.graph) {
        writer.job = None;
        return Err(error);
    }
    if plan.fresh {
        adopt(shared, &mut writer, &plan.graph);
        release_pending_locations(shared, &mut writer)?;
    } else {
        publish_grown(shared, &mut writer, &plan.graph);
    }
    Ok(true)
}

fn abandon(shared: &Shared, plan: &Plan) {
    let mut writer = shared.lock_writer();
    if still_current(&writer, plan) {
        writer.job = None;
    }
}

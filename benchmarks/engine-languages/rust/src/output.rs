use narsil::{Map, Value};

use crate::measure::{MeasuredPhase, VerifiedAnswer};

pub struct LoadTimes {
    pub documents: usize,
    pub insert_ns: u64,
    pub optimize_ns: u64,
    pub ready_ns: u64,
}

fn number(value: f64) -> Value {
    Value::Number(value)
}

fn whole(value: u64) -> Value {
    Value::Number(value as f64)
}

fn answer(answer: &VerifiedAnswer) -> Value {
    let mut map = Map::with_capacity(3);
    map.insert("count", whole(answer.count));
    map.insert("countExact", Value::Bool(answer.count_exact));
    map.insert(
        "hits",
        Value::Array(
            answer
                .hits
                .iter()
                .map(|(id, score)| Value::Array(vec![Value::String(id.clone()), number(*score)]))
                .collect(),
        ),
    );
    Value::Object(map)
}

fn phase(phase: &MeasuredPhase) -> Value {
    let mut map = Map::with_capacity(7);
    map.insert("queries", whole(phase.queries as u64));
    map.insert("warmupPasses", whole(phase.warmup_passes as u64));
    map.insert("passes", whole(phase.passes as u64));
    map.insert("threads", whole(phase.threads as u64));
    map.insert("wallNs", whole(phase.wall_ns));
    map.insert(
        "latencyNs",
        Value::Array(
            phase
                .latency_ns
                .iter()
                .map(|latency| whole(*latency))
                .collect(),
        ),
    );
    map.insert("mismatches", whole(phase.mismatches));
    Value::Object(map)
}

pub fn runner_output(
    workload: &str,
    threads: usize,
    load: &LoadTimes,
    verification: &[(&str, Vec<VerifiedAnswer>)],
    phases: &[(&str, MeasuredPhase)],
) -> Value {
    let mut load_map = Map::with_capacity(4);
    load_map.insert("documents", whole(load.documents as u64));
    load_map.insert("insertNs", whole(load.insert_ns));
    load_map.insert("optimizeNs", whole(load.optimize_ns));
    load_map.insert("readyNs", whole(load.ready_ns));
    let mut verification_map = Map::with_capacity(verification.len());
    for (name, answers) in verification {
        verification_map.insert(*name, Value::Array(answers.iter().map(answer).collect()));
    }
    let mut phase_map = Map::with_capacity(phases.len());
    for (name, measured) in phases {
        phase_map.insert(*name, phase(measured));
    }
    let mut map = Map::with_capacity(6);
    map.insert("engine", Value::String("rust".to_string()));
    map.insert("workload", Value::String(workload.to_string()));
    map.insert("threads", whole(threads as u64));
    map.insert("load", Value::Object(load_map));
    map.insert("verification", Value::Object(verification_map));
    map.insert("phases", Value::Object(phase_map));
    Value::Object(map)
}

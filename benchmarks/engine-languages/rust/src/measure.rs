use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Mutex, mpsc};
use std::time::Instant;

use narsil::QueryResult;

pub const MEMORY_READY_LINE: &str = "memory-ready";
pub const MEMORY_MEASURED_LINE: &str = "memory-measured";

pub struct VerifiedAnswer {
    pub count: u64,
    pub count_exact: bool,
    pub hits: Vec<(String, f64)>,
}

pub struct MeasuredPhase {
    pub queries: usize,
    pub warmup_passes: usize,
    pub passes: usize,
    pub threads: usize,
    pub wall_ns: u64,
    pub latency_ns: Vec<u64>,
    pub mismatches: u64,
}

pub fn elapsed_ns(since: Instant) -> u64 {
    u64::try_from(since.elapsed().as_nanos()).unwrap_or(u64::MAX)
}

pub fn verified(result: &QueryResult) -> Result<VerifiedAnswer, String> {
    let hits = result
        .hits
        .iter()
        .map(|hit| {
            hit.score
                .map(|score| (hit.id.clone(), score))
                .ok_or_else(|| format!("hit {} carries no score", hit.id))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(VerifiedAnswer {
        count: result.count,
        count_exact: result.count_exact,
        hits,
    })
}

fn same_answer(result: &QueryResult, expected: &VerifiedAnswer) -> bool {
    result.count == expected.count
        && result.count_exact == expected.count_exact
        && result.hits.len() == expected.hits.len()
        && result
            .hits
            .iter()
            .zip(&expected.hits)
            .all(|(hit, (id, score))| hit.id == *id && hit.score == Some(*score))
}

pub fn in_parallel<Work>(threads: usize, items: usize, work: Work) -> Result<(), String>
where
    Work: Fn(usize) -> Result<(), String> + Sync,
{
    let next = AtomicUsize::new(0);
    let stopped = AtomicBool::new(false);
    let failure: Mutex<Option<String>> = Mutex::new(None);
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| {
                while !stopped.load(Ordering::Relaxed) {
                    let item = next.fetch_add(1, Ordering::Relaxed);
                    if item >= items {
                        return;
                    }
                    if let Err(error) = work(item) {
                        stopped.store(true, Ordering::Relaxed);
                        let mut slot = failure
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        slot.get_or_insert(error);
                        return;
                    }
                }
            });
        }
    });
    match failure
        .into_inner()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
    {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

pub fn verify_each<Run>(queries: usize, run: Run) -> Result<Vec<VerifiedAnswer>, String>
where
    Run: Fn(usize) -> Result<QueryResult, String>,
{
    (0..queries).map(|query| verified(&run(query)?)).collect()
}

pub fn measure_phase<Run>(
    threads: usize,
    warmup_passes: usize,
    passes: usize,
    expected: &[VerifiedAnswer],
    run: Run,
) -> Result<MeasuredPhase, String>
where
    Run: Fn(usize) -> Result<QueryResult, String> + Sync,
{
    let queries = expected.len();
    let total = passes * queries;
    let latencies: Vec<AtomicU64> = (0..total).map(|_| AtomicU64::new(0)).collect();
    let mismatches = AtomicU64::new(0);
    let next = AtomicUsize::new(0);
    let wall_ns = std::thread::scope(|scope| -> Result<u64, String> {
        let (ready_tx, ready_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let mut starts = Vec::new();
        let run = &run;
        let latencies = &latencies;
        let mismatches = &mismatches;
        let next = &next;
        for thread in 0..threads {
            let (start_tx, start_rx) = mpsc::channel();
            let ready = ready_tx.clone();
            let done = done_tx.clone();
            std::thread::Builder::new()
                .spawn_scoped(scope, move || {
                    let warmed = (thread..warmup_passes * queries)
                        .step_by(threads)
                        .try_for_each(|item| run(item % queries).map(|_| ()));
                    let failed = warmed.is_err();
                    let _ = ready.send(warmed);
                    drop(ready);
                    if failed || start_rx.recv().is_err() {
                        return;
                    }
                    let measured = (|| -> Result<(), String> {
                        loop {
                            let item = next.fetch_add(1, Ordering::Relaxed);
                            if item >= total {
                                return Ok(());
                            }
                            let query = item % queries;
                            let began = Instant::now();
                            let result = run(query)?;
                            latencies[item].store(elapsed_ns(began), Ordering::Relaxed);
                            if !same_answer(&result, &expected[query]) {
                                mismatches.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                    })();
                    let _ = done.send(measured);
                })
                .map_err(|error| error.to_string())?;
            starts.push(start_tx);
        }
        drop(ready_tx);
        drop(done_tx);
        let warmed: Vec<_> = ready_rx.into_iter().collect();
        if warmed.len() != threads {
            return Err("a warm-up thread exited without an answer".to_string());
        }
        for result in warmed {
            result?;
        }
        let start = Instant::now();
        for sender in starts {
            sender.send(()).map_err(|error| error.to_string())?;
        }
        let finished: Vec<_> = done_rx.into_iter().collect();
        let elapsed = elapsed_ns(start);
        if finished.len() != threads {
            return Err("a measurement thread exited without an answer".to_string());
        }
        for result in finished {
            result?;
        }
        Ok(elapsed)
    })?;
    Ok(MeasuredPhase {
        queries,
        warmup_passes,
        passes,
        threads,
        wall_ns,
        latency_ns: latencies
            .into_iter()
            .map(|latency| latency.into_inner())
            .collect(),
        mismatches: mismatches.into_inner(),
    })
}

pub fn hold_for_memory_reading() -> Result<(), String> {
    let mut stdout = std::io::stdout().lock();
    writeln!(stdout, "{MEMORY_READY_LINE}").map_err(|error| error.to_string())?;
    stdout.flush().map_err(|error| error.to_string())?;
    drop(stdout);
    let mut line = String::new();
    let read = std::io::stdin()
        .lock()
        .read_line(&mut line)
        .map_err(|error| error.to_string())?;
    if read == 0 {
        return Err("the driver closed stdin before it measured memory".to_string());
    }
    if line.trim() != MEMORY_MEASURED_LINE {
        return Err(format!(
            "the driver answered {line:?} where the runner waits for {MEMORY_MEASURED_LINE}"
        ));
    }
    Ok(())
}

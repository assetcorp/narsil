use std::panic::{AssertUnwindSafe, catch_unwind};

use tokio::sync::oneshot;

use crate::errors::ApiError;

pub struct CpuPool {
    pool: rayon::ThreadPool,
    threads: usize,
}

impl CpuPool {
    pub fn new(threads: usize) -> Result<CpuPool, String> {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .thread_name(|index| format!("narsil-search-{index}"))
            .build()
            .map_err(|error| format!("could not start the search threads: {error}"))?;
        Ok(CpuPool { pool, threads })
    }

    pub fn threads(&self) -> usize {
        self.threads
    }

    pub async fn run<F, R>(&self, work: F) -> Result<R, ApiError>
    where
        F: FnOnce() -> R + Send + 'static,
        R: Send + 'static,
    {
        let (sender, receiver) = oneshot::channel();
        self.pool.spawn(move || {
            if sender.is_closed() {
                return;
            }
            let outcome = catch_unwind(AssertUnwindSafe(work));
            let _ = sender.send(outcome);
        });
        match receiver.await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(_)) => Err(ApiError::internal(
                "The search thread panicked while serving the request",
            )),
            Err(_) => Err(ApiError::internal(
                "The search thread stopped before it answered",
            )),
        }
    }
}

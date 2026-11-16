use std::num::NonZeroUsize;
use std::panic::{AssertUnwindSafe, catch_unwind};

use narsil::{ErrorCode, NarsilError};
use tokio::sync::oneshot;

const QUERY_THREAD_NAME: &str = "narsil-query";

pub(crate) struct QueryThreads {
    pool: rayon::ThreadPool,
}

impl QueryThreads {
    pub(crate) fn new() -> Result<QueryThreads, NarsilError> {
        let threads = std::thread::available_parallelism().map_or(1, NonZeroUsize::get);
        rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .thread_name(|at| format!("{QUERY_THREAD_NAME}-{at}"))
            .build()
            .map(|pool| QueryThreads { pool })
            .map_err(|failure| {
                NarsilError::new(
                    ErrorCode::INTERNAL_ERROR,
                    format!("The server could not start its query threads: {failure}"),
                )
            })
    }

    pub(crate) async fn run<R, F>(&self, work: F) -> Option<R>
    where
        R: Send + 'static,
        F: FnOnce() -> R + Send + 'static,
    {
        let (sender, receiver) = oneshot::channel();
        self.pool.spawn(move || {
            let _ = sender.send(catch_unwind(AssertUnwindSafe(work)));
        });
        receiver.await.ok().and_then(Result::ok)
    }
}

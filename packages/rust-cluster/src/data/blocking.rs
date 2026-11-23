use crate::error::{ClusterError, ClusterResult, codes};

pub(crate) async fn off_executor<T, F>(work: F) -> ClusterResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tokio::task::spawn_blocking(work).await.map_err(|_| {
        ClusterError::new(
            codes::INTERNAL_ERROR,
            "A call on the node's local engine stopped before it finished",
        )
    })
}

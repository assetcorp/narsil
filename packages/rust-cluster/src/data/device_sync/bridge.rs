use std::future::Future;
use std::sync::mpsc::sync_channel;

use narsil::{ErrorCode, NarsilError, Value};
use tokio::runtime::{Handle, RuntimeFlavor};

use crate::error::{ClusterError, ClusterResult};

const CLUSTER_CODE_DETAIL: &str = "clusterCode";

pub(crate) fn narsil_error_of(error: ClusterError) -> NarsilError {
    let known = ErrorCode::from_name(error.code());
    let mut details: Vec<(String, Value)> = error
        .details()
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    if known.is_none() {
        details.push((CLUSTER_CODE_DETAIL.to_string(), Value::from(error.code())));
    }
    NarsilError::new(known.unwrap_or(ErrorCode::INTERNAL_ERROR), error.message())
        .with_details(details)
}

fn node_stopped() -> NarsilError {
    NarsilError::new(
        ErrorCode::INSTANCE_SHUT_DOWN,
        "The cluster node stopped before a feed read finished",
    )
}

pub(crate) fn wait_on<T, F>(runtime: &Handle, work: F) -> narsil::Result<T>
where
    T: Send + 'static,
    F: Future<Output = ClusterResult<T>> + Send + 'static,
{
    let (send, receive) = sync_channel(1);
    let receive_answer = move || receive.recv().map_err(|_| node_stopped());
    let answer = match Handle::try_current() {
        Ok(current) if current.runtime_flavor() == RuntimeFlavor::CurrentThread => {
            return Err(NarsilError::new(
                ErrorCode::INTERNAL_ERROR,
                "A cluster feed read cannot wait inside a single-threaded runtime",
            ));
        }
        Ok(_) => {
            runtime.spawn(async move {
                let _ = send.send(work.await);
            });
            tokio::task::block_in_place(receive_answer)
        }
        Err(_) => {
            runtime.spawn(async move {
                let _ = send.send(work.await);
            });
            receive_answer()
        }
    }?;
    answer.map_err(narsil_error_of)
}

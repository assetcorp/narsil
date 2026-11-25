use std::collections::HashMap;

use narsil::Value;
use tokio::time::sleep_until;

use super::WriteRouter;
use super::rules::{
    forward_interrupted, forward_unsent, retriable, shutdown_outcome, transport_failure,
    unsent_after, window_ended_outcome,
};
use super::window::AttemptWindow;
use super::write::{Attempted, PendingWrite, Refused};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{CARRIER_ERROR_TYPE, TransportMessage, message_types};
use crate::node::generate_node_id;
use crate::payload::client::{
    decode_answer, encode_forward_batch_request, encode_forward_request, forwarded_batch_results,
    forwarded_document_id,
};
use crate::payload::forward::{ForwardKind, WriteFailure};
use crate::wire_size::wire_batches;

fn ended_window(serving_name: &str, document_id: &str, shutting_down: bool) -> ClusterError {
    if shutting_down {
        shutdown_outcome(serving_name, document_id)
    } else {
        window_ended_outcome(serving_name, document_id)
    }
}

pub(super) fn unsent_after_window(
    serving_name: &str,
    writes: &[PendingWrite],
    shutting_down: bool,
) -> Vec<(usize, Attempted)> {
    writes
        .iter()
        .map(|write| {
            let ended = ended_window(serving_name, write.document_id(), shutting_down);
            (write.position, Err(Refused::unsent(ended)))
        })
        .collect()
}

pub(super) enum Unanswered {
    Failed(ClusterError),
    WindowEnded { sent: bool },
}

impl WriteRouter {
    fn refusal_from(
        &self,
        failure: WriteFailure,
        serving_name: &str,
        primary: &str,
    ) -> Box<Refused> {
        let mut refused = Refused::from_failure(failure);
        refused.error = refused
            .error
            .with_detail("indexName", Value::from(serving_name))
            .with_detail("primaryNodeId", Value::from(primary));
        refused
    }

    pub(super) async fn send_to_primary(
        &self,
        primary: &str,
        message_type: &str,
        payload: Vec<u8>,
        window: Option<&AttemptWindow>,
    ) -> Result<TransportMessage, Unanswered> {
        let message = TransportMessage::new(
            message_type,
            self.node_id.as_str(),
            generate_node_id().map_err(Unanswered::Failed)?,
            payload,
        );
        let mut failure = None;
        for target in self.view.targets(primary) {
            let sending = self.transport.send(&target, message.clone());
            let answered = match window {
                None => sending.await,
                Some(window) => {
                    if self.is_stopping() || !window.start() {
                        return Err(Unanswered::WindowEnded { sent: false });
                    }
                    let mut shutting_down = self.stopping.subscribe();
                    tokio::select! {
                        answered = sending => answered,
                        _ = shutting_down.wait_for(|stopping| *stopping) => {
                            return Err(Unanswered::WindowEnded { sent: true });
                        }
                        () = sleep_until(window.deadline) => {
                            return Err(Unanswered::WindowEnded { sent: true });
                        }
                    }
                }
            };
            match answered {
                Ok(answer) if answer.message_type == CARRIER_ERROR_TYPE => {
                    failure = answer.failure();
                    break;
                }
                Ok(answer) => return Ok(answer),
                Err(error) => {
                    let unsent = error.code() == codes::TRANSPORT_CONNECT_FAILED;
                    failure = Some(error);
                    if !unsent {
                        break;
                    }
                }
            }
        }
        let error = failure.unwrap_or_else(|| {
            ClusterError::new(
                codes::TRANSPORT_CONNECT_FAILED,
                format!("Node '{primary}' has no address to send to"),
            )
        });
        Err(Unanswered::Failed(transport_failure(
            error,
            format!("Node '{primary}' did not answer a forwarded write"),
            primary,
        )))
    }

    async fn forward_one(
        &self,
        serving_name: &str,
        index_uuid: Option<&str>,
        primary: &str,
        write: &PendingWrite,
        window: &AttemptWindow,
    ) -> Attempted {
        let payload = encode_forward_request(serving_name, index_uuid, &write.outgoing());
        let sent = self
            .send_to_primary(
                primary,
                message_types::REPLICATION_FORWARD,
                payload,
                Some(window),
            )
            .await;
        let answer = match sent {
            Ok(answer) => answer,
            Err(Unanswered::Failed(error)) => return Err(Refused::of(error)),
            Err(Unanswered::WindowEnded { sent }) => {
                let ended = ended_window(serving_name, write.document_id(), self.is_stopping());
                return Err(if sent {
                    Refused::of(ended)
                } else {
                    Refused::unsent(ended)
                });
            }
        };
        let decoded = decode_answer(&answer, serving_name)
            .map_err(|failure| self.refusal_from(failure, serving_name, primary))?;
        if write.write.kind == ForwardKind::Insert {
            forwarded_document_id(&decoded).map_err(Refused::of)?;
        }
        Ok(())
    }

    async fn forward_chunk(
        &self,
        serving_name: &str,
        index_uuid: Option<&str>,
        primary: &str,
        chunk: &[PendingWrite],
        window: &AttemptWindow,
    ) -> ClusterResult<Vec<Attempted>> {
        if chunk.is_empty() {
            return Ok(Vec::new());
        }
        let operations: Vec<_> = chunk.iter().map(PendingWrite::outgoing).collect();
        let payload = encode_forward_batch_request(serving_name, index_uuid, &operations);
        let sent = self
            .send_to_primary(
                primary,
                message_types::REPLICATION_FORWARD_BATCH,
                payload,
                Some(window),
            )
            .await;
        let answer = match sent {
            Ok(answer) => answer,
            Err(Unanswered::Failed(error)) => return Err(error),
            Err(Unanswered::WindowEnded { sent: false }) => {
                return Ok(unsent_after_window(serving_name, chunk, self.is_stopping())
                    .into_iter()
                    .map(|(_, attempted)| attempted)
                    .collect());
            }
            Err(Unanswered::WindowEnded { sent: true }) => {
                let shutting_down = self.is_stopping();
                return Ok(chunk
                    .iter()
                    .map(|write| {
                        let ended = ended_window(serving_name, write.document_id(), shutting_down);
                        Err(Refused::of(ended))
                    })
                    .collect());
            }
        };
        let decoded = decode_answer(&answer, serving_name)
            .map_err(|failure| self.refusal_from(failure, serving_name, primary).error)?;
        let results = forwarded_batch_results(&decoded)?;
        if results.len() != chunk.len() {
            return Err(ClusterError::new(
                codes::QUERY_ROUTING_FAILED,
                format!(
                    "Remote primary answered {} results for {} forwarded operations",
                    results.len(),
                    chunk.len()
                ),
            )
            .with_detail("indexName", Value::from(serving_name))
            .with_detail("primaryNodeId", Value::from(primary)));
        }
        Ok(chunk
            .iter()
            .zip(results)
            .map(|(write, (document_id, outcome))| {
                if document_id != write.document_id() {
                    return Err(Refused::of(
                        ClusterError::new(
                            codes::QUERY_ROUTING_FAILED,
                            format!(
                                "Remote primary answered out of order for forwarded operation '{}'",
                                write.document_id()
                            ),
                        )
                        .with_detail("indexName", Value::from(serving_name))
                        .with_detail("primaryNodeId", Value::from(primary)),
                    ));
                }
                outcome.map_err(|failure| self.refusal_from(failure, serving_name, primary))
            })
            .collect())
    }

    pub(super) async fn forward_to(
        &self,
        serving_name: &str,
        index_uuid: Option<&str>,
        primary: &str,
        writes: &[PendingWrite],
        window: &AttemptWindow,
    ) -> Vec<(usize, Attempted)> {
        if self.is_stopping() || window.closed() {
            return unsent_after_window(serving_name, writes, self.is_stopping());
        }
        if let [only] = writes {
            let attempted = self
                .forward_one(serving_name, index_uuid, primary, only, window)
                .await;
            return vec![(only.position, attempted)];
        }
        let settles_as_equal = writes
            .first()
            .is_some_and(|write| write.write.kind == ForwardKind::Insert);
        let mut outcomes = Vec::with_capacity(writes.len());
        let mut awaiting_retry: HashMap<String, Box<Refused>> = HashMap::new();
        let mut undelivered: Option<ClusterError> = None;
        for planned in wire_batches(writes, PendingWrite::wire_bytes, |_, _| true) {
            if self.is_stopping() || window.closed() {
                outcomes.extend(unsent_after_window(
                    serving_name,
                    planned,
                    self.is_stopping(),
                ));
                continue;
            }
            if let Some(error) = &undelivered {
                outcomes.extend(
                    planned
                        .iter()
                        .map(|write| (write.position, Err(Refused::of(error.clone())))),
                );
                continue;
            }
            let mut chunk = Vec::with_capacity(planned.len());
            for write in planned {
                match awaiting_retry.get(write.document_id()) {
                    Some(earlier) => {
                        let mut withheld = earlier.clone();
                        withheld.withheld = true;
                        outcomes.push((write.position, Err(withheld)));
                    }
                    None => chunk.push(write.clone()),
                }
            }
            if chunk.is_empty() {
                continue;
            }
            let answered = match self
                .forward_chunk(serving_name, index_uuid, primary, &chunk, window)
                .await
            {
                Ok(answered) => answered,
                Err(error) => {
                    if forward_unsent(&error) || forward_interrupted(&error) {
                        undelivered = Some(unsent_after(&error));
                    }
                    chunk
                        .iter()
                        .map(|_| Err(Refused::of(error.clone())))
                        .collect()
                }
            };
            for (write, attempted) in chunk.iter().zip(answered) {
                if let Err(refused) = &attempted
                    && retriable(refused, settles_as_equal)
                {
                    awaiting_retry.insert(write.document_id().to_string(), refused.clone());
                }
                outcomes.push((write.position, attempted));
            }
        }
        outcomes
    }
}

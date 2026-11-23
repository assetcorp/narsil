use std::sync::atomic::Ordering;
use std::sync::{Arc, Weak};

use narsil::Value;

use super::member::NodeInner;
use super::not_ready::{answer_ping, not_ready};
use crate::controller::{is_controller_message, lock};
use crate::data::DataRole;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{TransportMessage, is_specified_message_type, message_types, refusal};
use crate::transport::{Respond, listen_handler};

fn not_controller(node_id: &str) -> ClusterError {
    ClusterError::new(
        codes::NODE_NOT_CONTROLLER,
        format!("Node '{node_id}' holds no controller lease, so it answers no controller message"),
    )
    .with_detail("nodeId", Value::String(node_id.to_string()))
}

impl NodeInner {
    async fn answer(&self, message: TransportMessage, respond: Respond) {
        let node_id = self.node_id();
        if message.message_type == message_types::CLUSTER_PING {
            return respond.send(answer_ping(&message, node_id)).await;
        }
        let joined = self.joined.load(Ordering::Acquire);
        if joined && message.message_type == message_types::SUGGESTIONS_COUNTS {
            return self.suggestions.answer_counts(message, respond).await;
        }
        if is_controller_message(&message.message_type) {
            return match &self.controller {
                Some(controller) if controller.is_listening() => {
                    controller.handle(message, respond).await
                }
                _ if !joined => {
                    respond
                        .send(refusal(&message, node_id, &not_ready(node_id)))
                        .await
                }
                _ => {
                    respond
                        .send(refusal(&message, node_id, &not_controller(node_id)))
                        .await
                }
            };
        }
        let answered = DataRole::answers(&message.message_type);
        match &self.data {
            Some(data) if joined && answered => data.answer(message, respond).await,
            _ if joined && !is_specified_message_type(&message.message_type) => {}
            _ => {
                respond
                    .send(refusal(&message, node_id, &not_ready(node_id)))
                    .await
            }
        }
    }

    pub(super) async fn listen(self: &Arc<Self>) -> ClusterResult<()> {
        let inner: Weak<NodeInner> = Arc::downgrade(self);
        let fallback_id = self.node_id().to_string();
        let handler = listen_handler(move |message: TransportMessage, respond: Respond| {
            let inner = inner.upgrade();
            let fallback_id = fallback_id.clone();
            async move {
                match inner {
                    Some(inner) => inner.answer(message, respond).await,
                    None => {
                        respond
                            .send(refusal(&message, &fallback_id, &not_ready(&fallback_id)))
                            .await
                    }
                }
                Ok(())
            }
        });
        let listening = self.transport.listen(handler).await?;
        if let Some(previous) = lock(&self.listening).replace(listening) {
            previous.stop();
        }
        Ok(())
    }
}

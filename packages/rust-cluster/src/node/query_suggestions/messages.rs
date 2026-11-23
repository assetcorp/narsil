use std::sync::Arc;

use narsil::{Map, QuerySuggestionsBuildStatus, Value, encode_msgpack};

use super::NodeSuggestions;
use crate::controller::validate_index_name;
use crate::data::blocking::off_executor;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{TransportMessage, refusal};
use crate::node::decode_request_payload;
use crate::transport::Respond;

fn index_name_of(message: &TransportMessage) -> ClusterResult<String> {
    let decoded = decode_request_payload(&message.payload, &message.message_type)?;
    let Some(Value::String(index_name)) = decoded
        .as_object()
        .and_then(|fields| fields.get("indexName"))
    else {
        return Err(ClusterError::new(
            codes::CONFIG_INVALID,
            format!(
                "A {} request needs \"indexName\" as a string",
                message.message_type
            ),
        ));
    };
    validate_index_name(index_name)?;
    Ok(index_name.clone())
}

pub(super) async fn answer_counts(
    suggestions: &NodeSuggestions,
    message: TransportMessage,
    respond: Respond,
) {
    let node_id = suggestions.node_id.as_str();
    let opened = match (index_name_of(&message), suggestions.service()) {
        (Ok(index_name), Ok(service)) => off_executor(move || service.history_stream(&index_name))
            .await
            .and_then(|opened| opened.map_err(ClusterError::from)),
        (Err(error), _) | (_, Err(error)) => Err(error),
    };
    let mut stream = match opened {
        Ok(stream) => stream,
        Err(error) => {
            respond.send(refusal(&message, node_id, &error)).await;
            return;
        }
    };
    loop {
        let read = off_executor(move || {
            let chunk = stream.next_chunk();
            (stream, chunk)
        })
        .await;
        let chunk = match read {
            Ok((returned, Ok(Some(chunk)))) => {
                stream = returned;
                chunk
            }
            Ok((_, Ok(None))) => return,
            Ok((_, Err(error))) => {
                suggestions.report(&ClusterError::from(error));
                return;
            }
            Err(error) => {
                suggestions.report(&error);
                return;
            }
        };
        let reply = TransportMessage::new(
            message.message_type.as_str(),
            node_id,
            message.request_id.as_str(),
            chunk,
        );
        respond.send(reply).await;
    }
}

async fn start_build(
    suggestions: &NodeSuggestions,
    message: &TransportMessage,
) -> ClusterResult<Vec<u8>> {
    if !(suggestions.is_controller)() {
        let node_id = suggestions.node_id.as_str();
        return Err(ClusterError::new(
            codes::NODE_NOT_CONTROLLER,
            format!("Node '{node_id}' does not hold the controller lease"),
        )
        .with_detail("nodeId", Value::from(node_id)));
    }
    let index_name = index_name_of(message)?;
    let service = suggestions.service()?;
    suggestions.view.refresh(&index_name).await?;
    let build = off_executor(move || service.begin_build(&index_name)).await??;
    let status = match build.status {
        QuerySuggestionsBuildStatus::Skipped => "skipped",
        _ => "running",
    };
    let mut answer = Map::with_capacity(2);
    answer.insert("buildId", Value::String(build.build_id));
    answer.insert("status", Value::from(status));
    Ok(encode_msgpack(&Value::Object(answer))?)
}

pub(super) async fn answer_build(
    suggestions: Arc<NodeSuggestions>,
    message: TransportMessage,
    respond: Respond,
) {
    let node_id = suggestions.node_id.as_str();
    let reply = match start_build(&suggestions, &message).await {
        Ok(payload) => TransportMessage::new(
            message.message_type.as_str(),
            node_id,
            message.request_id.as_str(),
            payload,
        ),
        Err(error) => refusal(&message, node_id, &error),
    };
    respond.send(reply).await;
}

use narsil::{Map, Value, decode_msgpack, encode_msgpack};

use crate::coordinator::etcd::EtcdCoordinator;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{ERROR_TYPE_SUFFIX, TransportMessage};
use crate::node::generate_node_id;
use crate::transport::NodeTransport;

pub(crate) struct Exchange<'e> {
    pub(crate) transport: &'e dyn NodeTransport,
    pub(crate) sender_id: &'e str,
    pub(crate) targets: Vec<String>,
    pub(crate) message_type: &'e str,
    pub(crate) payload: Value,
    pub(crate) failure_message: String,
    pub(crate) details: Map,
}

fn with_details(mut error: ClusterError, details: &Map) -> ClusterError {
    for (key, value) in details.iter() {
        error = error.with_detail(key, value.clone());
    }
    error
}

pub(crate) async fn node_targets(
    coordinator: &EtcdCoordinator,
    node_id: &str,
) -> ClusterResult<Vec<String>> {
    let nodes = coordinator.list_nodes().await?;
    let address = nodes
        .iter()
        .find(|node| node.node_id == node_id)
        .map(|node| node.address.clone())
        .unwrap_or_default();
    if address.is_empty() || address == node_id {
        return Ok(vec![node_id.to_string()]);
    }
    Ok(vec![address, node_id.to_string()])
}

fn decode_reply(answer: &TransportMessage, exchange: &Exchange<'_>) -> ClusterResult<Map> {
    let Ok(Value::Object(decoded)) = decode_msgpack(&answer.payload) else {
        return Err(with_details(
            ClusterError::new(
                codes::ALLOCATION_FAILED,
                format!("{}: the answer was unreadable", exchange.failure_message),
            ),
            &exchange.details,
        ));
    };
    let refused = answer.message_type.ends_with(ERROR_TYPE_SUFFIX)
        || matches!(decoded.get("error"), Some(Value::Bool(true)));
    if !refused {
        return Ok(decoded);
    }
    let code = match decoded.get("code") {
        Some(Value::String(code)) => code.clone(),
        _ => codes::ALLOCATION_FAILED.to_string(),
    };
    let message = match decoded.get("message") {
        Some(Value::String(message)) => message.clone(),
        _ => exchange.failure_message.clone(),
    };
    let mut error = ClusterError::new(code, message);
    if let Some(Value::Object(remote)) = decoded.get("details") {
        error = with_details(error, remote);
    }
    Err(with_details(error, &exchange.details))
}

pub(crate) async fn exchange_message(exchange: Exchange<'_>) -> ClusterResult<Map> {
    let message = TransportMessage::new(
        exchange.message_type,
        exchange.sender_id,
        generate_node_id()?,
        encode_msgpack(&exchange.payload)?,
    );
    let mut last_error = with_details(
        ClusterError::new(
            codes::QUERY_NO_ACTIVE_REPLICA,
            exchange.failure_message.clone(),
        ),
        &exchange.details,
    );
    for target in &exchange.targets {
        match exchange.transport.send(target, message.clone()).await {
            Ok(answer) => return decode_reply(&answer, &exchange),
            Err(error) => {
                last_error = with_details(
                    ClusterError::new(
                        codes::QUERY_NO_ACTIVE_REPLICA,
                        exchange.failure_message.clone(),
                    ),
                    &exchange.details,
                )
                .with_detail("transportCode", Value::from(error.code()));
            }
        }
    }
    Err(last_error)
}

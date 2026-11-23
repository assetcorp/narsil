use narsil::{Map, Value, decode_msgpack, encode_msgpack};

use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{ERROR_TYPE_SUFFIX, TransportMessage};
use crate::node::generate_node_id;
use crate::transport::NodeTransport;

const TRANSPORT_CODE_PREFIX: &str = "TRANSPORT_";

pub(crate) struct RebalanceExchange<'e> {
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

pub(crate) fn decode_rebalance_reply(
    response: &TransportMessage,
    failure_message: &str,
    details: &Map,
) -> ClusterResult<Map> {
    let Ok(Value::Object(decoded)) = decode_msgpack(&response.payload) else {
        return Err(with_details(
            ClusterError::new(
                codes::ALLOCATION_FAILED,
                format!("{failure_message}: the answer was unreadable"),
            ),
            details,
        ));
    };
    if response.message_type.ends_with(ERROR_TYPE_SUFFIX)
        || decoded.get("error") == Some(&Value::Bool(true))
    {
        let code = decoded
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or(codes::ALLOCATION_FAILED);
        let message = decoded
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or(failure_message);
        let mut error = ClusterError::new(code, message);
        if let Some(Value::Object(remote)) = decoded.get("details") {
            error = with_details(error, remote);
        }
        return Err(with_details(error, details));
    }
    Ok(decoded)
}

pub(crate) async fn exchange_rebalance_message(
    exchange: RebalanceExchange<'_>,
) -> ClusterResult<Map> {
    let message = TransportMessage::new(
        exchange.message_type,
        exchange.sender_id,
        generate_node_id()?,
        encode_msgpack(&exchange.payload)?,
    );
    let mut last_error = with_details(
        ClusterError::new(
            codes::QUERY_NO_ACTIVE_REPLICA,
            exchange.failure_message.as_str(),
        ),
        &exchange.details,
    );
    for target in &exchange.targets {
        match exchange.transport.send(target, message.clone()).await {
            Ok(response) => {
                return decode_rebalance_reply(
                    &response,
                    &exchange.failure_message,
                    &exchange.details,
                );
            }
            Err(error) if error.code().starts_with(TRANSPORT_CODE_PREFIX) => {
                last_error = with_details(
                    ClusterError::new(
                        codes::QUERY_NO_ACTIVE_REPLICA,
                        exchange.failure_message.as_str(),
                    ),
                    &exchange.details,
                )
                .with_detail("transportCode", Value::from(error.code()));
            }
            Err(error) => return Err(error),
        }
    }
    Err(last_error)
}

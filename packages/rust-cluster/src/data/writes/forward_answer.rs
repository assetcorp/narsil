use std::sync::Arc;

use super::PrimaryWrites;
use super::forward_memory::BlockCheck;
use super::scope::Outcome;
use crate::message::{ERROR_TYPE_SUFFIX, TransportMessage, message_types};
use crate::payload::decodable;
use crate::payload::forward::{
    WriteFailure, decode_forward, decode_forward_batch, encode_forward_answer,
    encode_forward_batch_answer, encode_forward_refusal,
};

impl PrimaryWrites {
    fn reply(
        &self,
        request: &TransportMessage,
        message_type: String,
        payload: Vec<u8>,
    ) -> TransportMessage {
        TransportMessage::new(
            message_type,
            self.node_id.as_str(),
            request.request_id.as_str(),
            payload,
        )
    }

    fn refuse(&self, request: &TransportMessage, failure: &WriteFailure) -> TransportMessage {
        let message_type = format!("{}{ERROR_TYPE_SUFFIX}", request.message_type);
        self.reply(request, message_type, encode_forward_refusal(failure))
    }

    pub(crate) async fn answer_forward(
        self: &Arc<Self>,
        message: &TransportMessage,
    ) -> TransportMessage {
        let decoded = decodable(&message.payload, &message.message_type)
            .and_then(|()| decode_forward(&message.payload));
        let request = match decoded {
            Ok(request) => request,
            Err(error) => return self.refuse(message, &WriteFailure::from(error)),
        };
        let _admitted = match self.admit_forwarded(&request) {
            Ok(admitted) => admitted,
            Err(error) => return self.refuse(message, &WriteFailure::from(error)),
        };
        match self.refused_by_local_copy(&request).await {
            Ok(None) => {}
            Ok(Some(error)) | Err(error) => {
                return self.refuse(message, &WriteFailure::from(error));
            }
        }
        let document_id = request.operations[0].document_id.clone();
        let outcome = match self
            .apply_request(request, false, BlockCheck::Forwarded(None))
            .await
        {
            Ok(mut outcomes) => outcomes.pop().unwrap_or(Ok(())),
            Err(error) => Err(WriteFailure::from(error)),
        };
        match outcome {
            Ok(()) => self.reply(
                message,
                message_types::REPLICATION_FORWARD.to_string(),
                encode_forward_answer(&document_id),
            ),
            Err(failure) => self.refuse(message, &failure),
        }
    }

    pub(crate) async fn answer_forward_batch(
        self: &Arc<Self>,
        message: &TransportMessage,
    ) -> TransportMessage {
        let decoded = decodable(&message.payload, &message.message_type)
            .and_then(|()| decode_forward_batch(&message.payload));
        let request = match decoded {
            Ok(request) => request,
            Err(error) => return self.refuse(message, &WriteFailure::from(error)),
        };
        let document_ids: Vec<String> = request
            .operations
            .iter()
            .map(|operation| operation.document_id.clone())
            .collect();
        let (_admitted, refusal) = match self.admit_forwarded(&request) {
            Ok(admitted) => (admitted, None),
            Err(error) => (None, Some(error)),
        };
        let outcomes = match self.refused_by_local_copy(&request).await {
            Ok(None) => match self
                .apply_request(request, true, BlockCheck::Forwarded(refusal))
                .await
            {
                Ok(outcomes) => outcomes,
                Err(error) => document_ids
                    .iter()
                    .map(|_| Err(WriteFailure::from(error.clone())))
                    .collect(),
            },
            Ok(Some(error)) => document_ids
                .iter()
                .map(|_| Err(WriteFailure::from(error.clone())))
                .collect(),
            Err(error) => return self.refuse(message, &WriteFailure::from(error)),
        };
        let results: Vec<(String, Outcome)> = document_ids.into_iter().zip(outcomes).collect();
        self.reply(
            message,
            message_types::REPLICATION_FORWARD_BATCH.to_string(),
            encode_forward_batch_answer(&results),
        )
    }
}

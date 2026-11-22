use std::sync::Arc;

use narsil::Map;

use crate::error::ClusterError;
use crate::payload::client::OutgoingOperation;
use crate::payload::forward::{
    AbandonedWrite, ForwardKind, ForwardOperation, WriteCondition, WriteFailure,
};

pub(crate) struct ClientWrite {
    pub(crate) document_id: String,
    pub(crate) kind: ForwardKind,
    pub(crate) document: Option<Vec<u8>>,
    pub(crate) sent: Option<Map>,
}

#[derive(Clone)]
pub(super) struct PendingWrite {
    pub(super) position: usize,
    pub(super) write: Arc<ClientWrite>,
    pub(super) condition: Option<WriteCondition>,
}

impl PendingWrite {
    pub(super) fn document_id(&self) -> &str {
        &self.write.document_id
    }

    pub(super) fn outgoing(&self) -> OutgoingOperation<'_> {
        OutgoingOperation {
            document_id: &self.write.document_id,
            kind: self.write.kind,
            document: self.write.document.as_deref(),
            condition: self.condition,
        }
    }

    pub(super) fn forward_operation(&self) -> ForwardOperation {
        ForwardOperation {
            document_id: self.write.document_id.clone(),
            kind: self.write.kind,
            document: self.write.document.clone(),
            update_fields: None,
            condition: Ok(self.condition),
        }
    }

    pub(super) fn wire_bytes(&self) -> usize {
        self.write.document.as_ref().map_or(0, Vec::len)
    }
}

#[derive(Debug, Clone)]
pub(super) struct Refused {
    pub(super) error: ClusterError,
    pub(super) abandoned: Option<AbandonedWrite>,
    pub(super) withheld: bool,
}

impl Refused {
    pub(super) fn of(error: ClusterError) -> Box<Refused> {
        Box::new(Refused {
            error,
            abandoned: None,
            withheld: false,
        })
    }

    pub(super) fn from_failure(failure: WriteFailure) -> Box<Refused> {
        Box::new(Refused {
            error: failure.error,
            abandoned: failure.abandoned,
            withheld: false,
        })
    }
}

pub(super) type Attempted = Result<(), Box<Refused>>;

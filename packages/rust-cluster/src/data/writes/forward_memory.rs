use super::PrimaryWrites;
use crate::allocator::Table;
use crate::error::ClusterError;
use crate::memory::{AdmittedWrite, estimate_forwarded_bytes, find_write_block};
use crate::payload::forward::{ForwardKind, ForwardRequest};

pub(super) enum BlockCheck {
    ClientWrite,
    Forwarded(Option<ClusterError>),
}

fn writes_index(request: &ForwardRequest) -> bool {
    request
        .operations
        .iter()
        .any(|operation| operation.kind != ForwardKind::Remove)
}

impl PrimaryWrites {
    pub(super) fn admit_forwarded(
        &self,
        request: &ForwardRequest,
    ) -> Result<Option<AdmittedWrite>, ClusterError> {
        let Some(memory) = &self.memory else {
            return Ok(None);
        };
        let bytes = request
            .operations
            .iter()
            .filter(|operation| operation.kind != ForwardKind::Remove)
            .fold(0u64, |total, operation| {
                total.saturating_add(estimate_forwarded_bytes(operation))
            });
        if bytes == 0 {
            return Ok(None);
        }
        memory.before_admit();
        memory.pressure.admit(&request.index_name, bytes).map(Some)
    }

    pub(super) fn forwarded_block(
        &self,
        table: &Table,
        request: &ForwardRequest,
        check: BlockCheck,
    ) -> Option<ClusterError> {
        let BlockCheck::Forwarded(refusal) = check else {
            return None;
        };
        if !writes_index(request) {
            return None;
        }
        refusal
            .or_else(|| find_write_block(table, self.memory.as_deref().map(|memory| &memory.view)))
    }
}

use std::sync::Arc;

use narsil::Value;

use super::bridge::wait_on;
use super::shared_source::SharedFeedSource;
use crate::constants::{CHANGE_CAPTURE_SPEC_VERSION, DEVICE_SYNC_SPEC_VERSION};
use crate::coordinator::etcd::EtcdCoordinator;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::version::reaches_version;

pub(crate) struct Readiness {
    pub(crate) code: &'static str,
    pub(crate) what: &'static str,
    pub(crate) minimum: &'static str,
}

pub(crate) static DEVICE_SYNC_READINESS: Readiness = Readiness {
    code: codes::SYNC_NOT_READY,
    what: "can't read the log for a device feed",
    minimum: DEVICE_SYNC_SPEC_VERSION,
};

pub(crate) static CHANGE_CAPTURE_READINESS: Readiness = Readiness {
    code: codes::CHANGES_NOT_READY,
    what: "keep no history for change capture",
    minimum: CHANGE_CAPTURE_SPEC_VERSION,
};

pub(crate) fn not_ready(
    readiness: &Readiness,
    older: Vec<String>,
    index_name: &str,
) -> ClusterError {
    let Readiness {
        code,
        what,
        minimum,
    } = readiness;
    ClusterError::new(
        *code,
        format!(
            "The cluster has {} node(s) below specification version {minimum}, which {what}. Try again once every node registers that version",
            older.len()
        ),
    )
    .with_detail("indexName", Value::from(index_name))
    .with_detail("nodeIds", Value::Array(older.into_iter().map(Value::String).collect()))
    .with_detail("minimumVersion", Value::from(*minimum))
}

pub(crate) async fn nodes_below(
    coordinator: &EtcdCoordinator,
    minimum: &str,
) -> ClusterResult<Vec<String>> {
    let mut older: Vec<String> = coordinator
        .list_nodes()
        .await?
        .into_iter()
        .filter(|node| !reaches_version(&node.version, minimum))
        .map(|node| node.node_id)
        .collect();
    older.sort();
    Ok(older)
}

impl SharedFeedSource {
    pub(super) fn admit(
        &self,
        index_name: &str,
        readiness: &'static Readiness,
    ) -> narsil::Result<()> {
        let parts = self.0.parts()?;
        let coordinator = Arc::clone(&parts.coordinator);
        let view = Arc::clone(&parts.reads.view);
        let name = index_name.to_string();
        wait_on(&parts.runtime, async move {
            let older = nodes_below(&coordinator, readiness.minimum).await?;
            if !older.is_empty() {
                return Err(not_ready(readiness, older, &name));
            }
            view.current(&name).await?;
            Ok(())
        })
    }
}

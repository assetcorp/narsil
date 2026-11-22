#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

use narsil_cluster::coordinator::etcd::EtcdCoordinator;
use narsil_cluster::node::ClusterNodeConfig;

use crate::data_node::{DataNode, Scratch, coordinator_at};

const CHILD_ENDPOINT: &str = "NARSIL_CHILD_NODE_ETCD_ENDPOINT";
const CHILD_KEY_PREFIX: &str = "NARSIL_CHILD_NODE_KEY_PREFIX";
const CHILD_DIRECTORY: &str = "NARSIL_CHILD_NODE_DIRECTORY";
const CHILD_NODE_ID: &str = "NARSIL_CHILD_NODE_ID";
const CHILD_HEARTBEAT_TTL_SECONDS: u64 = 2;
const CHILD_HEARTBEAT_INTERVAL_MS: u64 = 500;
const START_WITH_OVERSIZED_WRITES_IGNORED: &str = "trap '' XFSZ; exec \"$0\" \"$@\"";
const CHILD_TEST: &str = "child_node::a_data_node_that_serves_until_its_process_is_killed";

fn beat_often(settings: &mut ClusterNodeConfig) {
    settings.heartbeat_interval_ms = CHILD_HEARTBEAT_INTERVAL_MS;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "the tests that kill a data node or limit its file sizes start this as a separate process"]
async fn a_data_node_that_serves_until_its_process_is_killed() {
    serve_until_killed().await;
}

async fn serve_until_killed() {
    let (Ok(endpoint), Ok(key_prefix), Ok(directory), Ok(node_id)) = (
        std::env::var(CHILD_ENDPOINT),
        std::env::var(CHILD_KEY_PREFIX),
        std::env::var(CHILD_DIRECTORY),
        std::env::var(CHILD_NODE_ID),
    ) else {
        return;
    };
    let coordinator = coordinator_at(endpoint, key_prefix, CHILD_HEARTBEAT_TTL_SECONDS).await;
    let _node = DataNode::start_configured(
        &coordinator,
        &node_id,
        &PathBuf::from(directory),
        &["data"],
        beat_often,
    )
    .await;
    std::future::pending::<()>().await;
}

pub struct ChildNode {
    child: Child,
}

impl ChildNode {
    pub fn spawn(
        endpoint: &str,
        key_prefix: &str,
        node_id: &str,
        directory: &Scratch,
    ) -> ChildNode {
        let test_binary = std::env::current_exe().expect("the test binary has a path");
        let child = Command::new("bash")
            .arg("-c")
            .arg(START_WITH_OVERSIZED_WRITES_IGNORED)
            .arg(test_binary)
            .args([CHILD_TEST, "--exact", "--ignored", "--test-threads=1"])
            .env(CHILD_ENDPOINT, endpoint)
            .env(CHILD_KEY_PREFIX, key_prefix)
            .env(CHILD_DIRECTORY, directory.path())
            .env(CHILD_NODE_ID, node_id)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("the node's process starts");
        ChildNode { child }
    }

    pub fn limit_file_size(&self, bytes: u64) {
        let status = Command::new("prlimit")
            .arg("--pid")
            .arg(self.child.id().to_string())
            .arg(format!("--fsize={bytes}:{bytes}"))
            .status()
            .expect("prlimit starts");
        assert!(
            status.success(),
            "prlimit lowers the node's file size limit"
        );
    }

    pub fn kill(&mut self) {
        self.child.kill().expect("the node's process is killed");
        self.child.wait().expect("the node's process exits");
    }
}

impl Drop for ChildNode {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

pub async fn registered_address(coordinator: &EtcdCoordinator, node_id: &str) -> Option<String> {
    coordinator
        .list_nodes()
        .await
        .expect("etcd lists the nodes")
        .into_iter()
        .find(|node| node.node_id == node_id)
        .map(|node| node.address)
}

pub fn file_sizes(directory: &Path) -> BTreeMap<PathBuf, u64> {
    let mut sizes = BTreeMap::new();
    let mut waiting = vec![directory.to_path_buf()];
    while let Some(next) = waiting.pop() {
        let Ok(entries) = std::fs::read_dir(&next) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if metadata.is_dir() {
                waiting.push(entry.path());
            } else {
                sizes.insert(entry.path(), metadata.len());
            }
        }
    }
    sizes
}

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, Weak};

use bytes::Bytes;
use narsil::suggestions_host::{HistoryFiles, HistoryStreamReader, RemoteFile};
use narsil::{Map, Value, encode_msgpack};
use tokio::runtime::Handle;

use super::super::identity::generate_node_id;
use super::super::member::NodeInner;
use super::super::rebalance::resolve_node_targets;
use crate::constants::QUERY_SUGGESTIONS_SPEC_VERSION;
use crate::controller::lock;
use crate::coordinator::etcd::EtcdCoordinator;
use crate::message::{TransportMessage, message_types};
use crate::transport::{ChunkHandler, NodeTransport};
use crate::version::reaches_version;

#[derive(Clone)]
pub(super) struct StagedFile {
    pub(super) key: String,
    pub(super) staged_key: String,
}

struct StreamState {
    reader: HistoryStreamReader,
    staged: Vec<StagedFile>,
    write_failed: bool,
}

pub(super) struct RemoteHistoryDeps<'d> {
    pub(super) node_id: &'d str,
    pub(super) coordinator: &'d EtcdCoordinator,
    pub(super) transport: &'d dyn NodeTransport,
    pub(super) files: &'d Arc<HistoryFiles>,
}

pub(super) fn remove_staged(files: &HistoryFiles, staged: &[StagedFile]) {
    for file in staged {
        let _ = files.remove(&file.staged_key);
    }
}

async fn stream_from(
    deps: &RemoteHistoryDeps<'_>,
    target: &str,
    message: TransportMessage,
    index_name: &str,
) -> Option<Vec<StagedFile>> {
    let prefix = HistoryFiles::staging_prefix().ok()?;
    let state = Arc::new(Mutex::new(StreamState {
        reader: HistoryStreamReader::new(index_name),
        staged: Vec::new(),
        write_failed: false,
    }));
    let held = Arc::clone(&state);
    let files = Arc::clone(deps.files);
    let handler: ChunkHandler = Box::new(move |chunk: Bytes| {
        let mut state = lock(&held);
        for file in state.reader.push(&chunk) {
            let staged_key = format!("{prefix}{}", state.staged.len());
            if !state.write_failed && files.write(&staged_key, &file.bytes).is_err() {
                state.write_failed = true;
            }
            state.staged.push(StagedFile {
                key: file.key,
                staged_key,
            });
        }
        Ok(())
    });
    let streamed = deps.transport.stream(target, message, handler).await;
    let (staged, clean) = {
        let state = lock(&state);
        let clean =
            !state.write_failed && state.reader.refusal().is_none() && state.reader.ends_cleanly();
        (state.staged.clone(), clean)
    };
    if streamed.is_err() || !clean {
        remove_staged(deps.files, &staged);
        return None;
    }
    Some(staged)
}

pub(super) async fn stage_node_history(
    deps: &RemoteHistoryDeps<'_>,
    node_id: &str,
    index_name: &str,
) -> Option<Vec<StagedFile>> {
    let mut payload = Map::with_capacity(1);
    payload.insert("indexName", Value::from(index_name));
    let encoded = encode_msgpack(&Value::Object(payload)).ok()?;
    let targets = resolve_node_targets(deps.coordinator, node_id).await.ok()?;
    for target in targets {
        let message = TransportMessage::new(
            message_types::SUGGESTIONS_COUNTS,
            deps.node_id,
            generate_node_id().ok()?,
            encoded.clone(),
        );
        if let Some(staged) = stream_from(deps, &target, message, index_name).await {
            return Some(staged);
        }
    }
    None
}

pub(super) struct Peer {
    pub(super) node_id: String,
    pub(super) speaks_counts: bool,
}

pub(super) async fn peer_nodes_of(deps: &RemoteHistoryDeps<'_>) -> VecDeque<Peer> {
    let Ok(nodes) = deps.coordinator.list_nodes().await else {
        return VecDeque::from([Peer {
            node_id: String::new(),
            speaks_counts: false,
        }]);
    };
    let mut peers: Vec<Peer> = nodes
        .into_iter()
        .filter(|node| node.node_id != deps.node_id)
        .map(|node| Peer {
            speaks_counts: reaches_version(&node.version, QUERY_SUGGESTIONS_SPEC_VERSION),
            node_id: node.node_id,
        })
        .collect();
    peers.sort_by(|left, right| left.node_id.cmp(&right.node_id));
    peers.into()
}

struct StagedNode {
    node_id: String,
    files: Vec<StagedFile>,
    next: usize,
}

#[derive(Clone)]
pub(super) struct RemoteSource {
    pub(super) node_id: String,
    pub(super) node: Weak<NodeInner>,
    pub(super) files: Arc<HistoryFiles>,
    pub(super) runtime: Handle,
}

impl RemoteSource {
    fn deps<'d>(&'d self, inner: &'d NodeInner) -> RemoteHistoryDeps<'d> {
        RemoteHistoryDeps {
            node_id: &self.node_id,
            coordinator: inner.coordinator(),
            transport: inner.transport(),
            files: &self.files,
        }
    }
}

pub(super) struct RemoteHistory {
    source: RemoteSource,
    index_name: String,
    peers: Option<VecDeque<Peer>>,
    current: Option<StagedNode>,
}

impl RemoteHistory {
    pub(super) fn new(source: RemoteSource, index_name: &str) -> RemoteHistory {
        RemoteHistory {
            source,
            index_name: index_name.to_string(),
            peers: None,
            current: None,
        }
    }

    fn finish_current(&mut self) {
        if let Some(current) = self.current.take() {
            remove_staged(&self.source.files, &current.files);
        }
    }

    fn next_peer(&mut self) -> Option<Peer> {
        if self.peers.is_none() {
            let peers = match self.source.node.upgrade() {
                Some(inner) => {
                    let deps = self.source.deps(&inner);
                    self.source.runtime.block_on(peer_nodes_of(&deps))
                }
                None => VecDeque::from([Peer {
                    node_id: String::new(),
                    speaks_counts: false,
                }]),
            };
            self.peers = Some(peers);
        }
        self.peers.as_mut()?.pop_front()
    }

    fn stage(&self, node_id: &str) -> Option<Vec<StagedFile>> {
        let inner = self.source.node.upgrade()?;
        let deps = self.source.deps(&inner);
        self.source
            .runtime
            .block_on(stage_node_history(&deps, node_id, &self.index_name))
    }

    fn next_staged_file(&mut self) -> Option<RemoteFile> {
        let current = self.current.as_mut()?;
        while let Some(file) = current.files.get(current.next) {
            current.next += 1;
            match self.source.files.read(&file.staged_key) {
                Ok(Some(bytes)) => {
                    return Some(RemoteFile::File {
                        node_id: current.node_id.clone(),
                        key: file.key.clone(),
                        bytes,
                    });
                }
                Ok(None) => {}
                Err(_) => {
                    let node_id = current.node_id.clone();
                    self.finish_current();
                    return Some(RemoteFile::Silent { node_id });
                }
            }
        }
        self.finish_current();
        None
    }
}

impl Iterator for RemoteHistory {
    type Item = RemoteFile;

    fn next(&mut self) -> Option<RemoteFile> {
        loop {
            if let Some(file) = self.next_staged_file() {
                return Some(file);
            }
            let peer = self.next_peer()?;
            let staged = if peer.speaks_counts {
                self.stage(&peer.node_id)
            } else {
                None
            };
            let Some(files) = staged else {
                return Some(RemoteFile::Silent {
                    node_id: peer.node_id,
                });
            };
            self.current = Some(StagedNode {
                node_id: peer.node_id,
                files,
                next: 0,
            });
        }
    }
}

impl Drop for RemoteHistory {
    fn drop(&mut self) {
        self.finish_current();
    }
}

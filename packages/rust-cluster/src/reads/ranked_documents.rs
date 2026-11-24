use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use narsil::{Map, Value};
use tokio::task::JoinSet;

use super::ReadDeps;
use super::node_messaging::{CopyRead, fetch_documents, read_documents_from_copies};
use crate::allocator::Table;
use crate::constants::FETCH_GROUP_DOCUMENT_IDS;
use crate::data::routed_partition;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::query::failover::Failure;
use crate::query::search_contexts::{RankingContext, SearchContextSet, release_search_contexts};

const NODE_LOSS_CODES: [&str; 3] = [
    codes::TRANSPORT_CONNECT_FAILED,
    codes::TRANSPORT_PEER_UNAVAILABLE,
    codes::TRANSPORT_TIMEOUT,
];

#[derive(Debug, Clone)]
pub(crate) struct RankedRead {
    pub(crate) last: bool,
    pub(crate) fields: Option<Vec<String>>,
    pub(crate) vectors: bool,
    pub(crate) require_every_partition: bool,
}

fn context_lost(context: &RankingContext, index_name: &str, cause: Option<&str>) -> ClusterError {
    let mut error = ClusterError::new(
        codes::SEARCH_CONTEXT_MISSING,
        format!(
            "Node '{}' no longer holds the documents it ranked for a search of index '{index_name}'",
            context.node_id
        ),
    )
    .with_detail("indexName", Value::from(index_name))
    .with_detail("nodeId", Value::from(context.node_id.as_str()))
    .with_detail("contextId", Value::from(context.context_id.as_str()));
    if let Some(cause) = cause {
        error = error.with_detail("cause", Value::from(cause));
    }
    error
}

fn lost_context_of(failure: Failure, context: &RankingContext, index_name: &str) -> ClusterError {
    let error = failure.error;
    let transport_code = error
        .details()
        .get("transportCode")
        .and_then(Value::as_str)
        .map(str::to_string);
    let lost = error.code() == codes::SEARCH_CONTEXT_MISSING
        || error.code() == codes::NODE_NOT_READY
        || transport_code
            .as_deref()
            .is_some_and(|code| NODE_LOSS_CODES.contains(&code));
    match lost {
        true => context_lost(context, index_name, Some(error.code())),
        false => error,
    }
}

pub(crate) struct RankedDocumentReader {
    deps: Arc<ReadDeps>,
    index_name: Arc<str>,
    table: Arc<Table>,
    sources: HashMap<String, RankingContext>,
    open: HashMap<String, RankingContext>,
}

async fn read_remote_context(
    deps: Arc<ReadDeps>,
    index_name: Arc<str>,
    partition_count: usize,
    context: RankingContext,
    document_ids: Vec<String>,
    read: RankedRead,
) -> ClusterResult<Vec<(String, Map)>> {
    let copy_read = CopyRead {
        fields: read.fields.clone(),
        vectors: read.vectors,
    };
    let mut documents = Vec::with_capacity(document_ids.len());
    let chunks: Vec<&[String]> = document_ids.chunks(FETCH_GROUP_DOCUMENT_IDS).collect();
    let chunk_count = chunks.len();
    for (at, chunk) in chunks.into_iter().enumerate() {
        let release_context = read.last && at + 1 == chunk_count;
        let routed: Vec<(String, u32)> = chunk
            .iter()
            .map(|id| (id.clone(), routed_partition(id, partition_count.max(1))))
            .collect();
        let fetched = fetch_documents(
            &deps,
            &context.node_id,
            &index_name,
            &routed,
            &copy_read,
            Some((&context.context_id, release_context)),
        )
        .await
        .map_err(|failure| lost_context_of(failure, &context, &index_name))?;
        documents.extend(fetched);
    }
    Ok(documents)
}

impl RankedDocumentReader {
    pub(crate) fn new(deps: &Arc<ReadDeps>, index_name: &str, table: &Table) -> Self {
        RankedDocumentReader {
            deps: Arc::clone(deps),
            index_name: Arc::from(index_name),
            table: Arc::new(table.clone()),
            sources: HashMap::new(),
            open: HashMap::new(),
        }
    }

    pub(crate) fn adopt(&mut self, contexts: SearchContextSet) {
        for context in contexts.opened {
            self.open.insert(context.context_id.clone(), context);
        }
        for (document_id, context) in contexts.sources {
            self.sources.entry(document_id).or_insert(context);
        }
    }

    fn release_quietly(&mut self, context_ids: Vec<String>) {
        let released: Vec<RankingContext> = context_ids
            .iter()
            .filter_map(|context_id| self.open.remove(context_id))
            .collect();
        release_search_contexts(&self.deps, &self.index_name, &released);
    }

    pub(crate) async fn read(
        &mut self,
        document_ids: &[String],
        read: RankedRead,
    ) -> ClusterResult<HashMap<String, Map>> {
        let mut by_context: Vec<(RankingContext, Vec<String>)> = Vec::new();
        let mut unsourced: Vec<String> = Vec::new();
        let mut seen: HashSet<&str> = HashSet::new();
        for document_id in document_ids {
            if !seen.insert(document_id) {
                continue;
            }
            let context = self
                .sources
                .get(document_id)
                .filter(|context| self.open.contains_key(&context.context_id));
            let Some(context) = context else {
                unsourced.push(document_id.clone());
                continue;
            };
            match by_context
                .iter_mut()
                .find(|(held, _)| held.context_id == context.context_id)
            {
                Some((_, ids)) => ids.push(document_id.clone()),
                None => by_context.push((context.clone(), vec![document_id.clone()])),
            }
        }
        if read.last {
            let idle: Vec<String> = self
                .open
                .keys()
                .filter(|context_id| {
                    !by_context
                        .iter()
                        .any(|(context, _)| context.context_id == **context_id)
                })
                .cloned()
                .collect();
            self.release_quietly(idle);
        }
        let partition_count = self.table.assignments.len();
        let mut reads = JoinSet::new();
        for (context, ids) in by_context {
            let (deps, index_name) = (Arc::clone(&self.deps), Arc::clone(&self.index_name));
            let read = read.clone();
            reads.spawn(async move {
                let context_id = context.context_id.clone();
                let found =
                    read_remote_context(deps, index_name, partition_count, context, ids, read)
                        .await;
                (Some(context_id), found)
            });
        }
        if !unsourced.is_empty() {
            let (deps, index_name, table) = (
                Arc::clone(&self.deps),
                Arc::clone(&self.index_name),
                Arc::clone(&self.table),
            );
            let copy_read = CopyRead {
                fields: read.fields.clone(),
                vectors: read.vectors,
            };
            let require_every_partition = read.require_every_partition;
            reads.spawn(async move {
                let found = read_documents_from_copies(
                    &deps,
                    &index_name,
                    &unsourced,
                    &table,
                    copy_read,
                    require_every_partition,
                    false,
                )
                .await
                .map(|documents| documents.into_iter().collect())
                .map_err(|failure| failure.error);
                (None, found)
            });
        }
        let mut documents = HashMap::new();
        let mut first_error = None;
        while let Some(joined) = reads.join_next().await {
            let (context_id, found) = joined.map_err(|error| {
                ClusterError::new(
                    codes::INTERNAL_ERROR,
                    format!("A document read stopped before it finished: {error}"),
                )
            })?;
            match found {
                Ok(found) => {
                    if read.last
                        && let Some(context_id) = context_id
                    {
                        self.open.remove(&context_id);
                    }
                    documents.extend(found);
                }
                Err(error) => {
                    first_error.get_or_insert(error);
                }
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(documents),
        }
    }

    pub(crate) fn release(&mut self) {
        let open: Vec<String> = self.open.keys().cloned().collect();
        self.release_quietly(open);
    }
}

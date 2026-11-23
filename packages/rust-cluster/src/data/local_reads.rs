use std::sync::Arc;

use narsil::{DocumentProjection, IndexInfo, Map};

use super::blocking::off_executor;
use super::copies::LocalCopies;
use super::queries::{QueryDeps, answer_query, answers_query};
use super::search_contexts::SearchContexts;
use super::writes::AllocationView;
use crate::error::ClusterResult;
use crate::message::{TransportMessage, refusal};

pub(crate) struct LocalReads {
    node_id: String,
    copies: Arc<LocalCopies>,
    view: Arc<AllocationView>,
    contexts: Arc<SearchContexts>,
}

impl LocalReads {
    pub(super) fn new(
        node_id: String,
        copies: Arc<LocalCopies>,
        view: Arc<AllocationView>,
        contexts: Arc<SearchContexts>,
    ) -> LocalReads {
        LocalReads {
            node_id,
            copies,
            view,
            contexts,
        }
    }

    pub(crate) fn refuse_orphaned(&self, index_name: &str) -> ClusterResult<()> {
        self.copies.refuse_orphaned(index_name)
    }

    pub(crate) fn list_indexes(&self) -> Vec<IndexInfo> {
        self.copies.engine.list_indexes()
    }

    pub(crate) fn answers(message_type: &str) -> bool {
        answers_query(message_type)
    }

    pub(crate) async fn answer(&self, message: &TransportMessage) -> TransportMessage {
        let deps = QueryDeps {
            node_id: &self.node_id,
            copies: Arc::clone(&self.copies),
            view: Arc::clone(&self.view),
            contexts: Arc::clone(&self.contexts),
        };
        match answer_query(&deps, message).await {
            Ok(reply) => reply,
            Err(error) => refusal(message, &self.node_id, &error),
        }
    }

    pub(crate) async fn get_multiple(
        &self,
        index_name: &str,
        document_ids: Vec<String>,
        vectors: bool,
    ) -> ClusterResult<Vec<(String, Map)>> {
        let copies = Arc::clone(&self.copies);
        let index_name = index_name.to_string();
        let projection = DocumentProjection::Fields {
            include: None,
            exclude: None,
            vectors: Some(vectors),
        };
        let found = off_executor(move || {
            copies
                .engine
                .get_multiple_with(&index_name, &document_ids, Some(&projection))
        })
        .await??;
        Ok(found.into_iter().collect())
    }
}

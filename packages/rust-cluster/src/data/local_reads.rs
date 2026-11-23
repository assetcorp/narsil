use std::sync::Arc;

use narsil::{DocumentProjection, IndexInfo, Map};

use super::blocking::off_executor;
use super::copies::LocalCopies;
use crate::error::ClusterResult;

pub(crate) struct LocalReads {
    copies: Arc<LocalCopies>,
}

impl LocalReads {
    pub(super) fn new(copies: Arc<LocalCopies>) -> LocalReads {
        LocalReads { copies }
    }

    pub(crate) fn refuse_orphaned(&self, index_name: &str) -> ClusterResult<()> {
        self.copies.refuse_orphaned(index_name)
    }

    pub(crate) fn list_indexes(&self) -> Vec<IndexInfo> {
        self.copies.engine.list_indexes()
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

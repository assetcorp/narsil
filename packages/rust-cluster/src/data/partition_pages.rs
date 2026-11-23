use narsil::replication::PartitionCopies;
use narsil::{DocumentProjection, ListParams, Value, encode_msgpack};

use super::copies::LocalCopies;
use crate::error::ClusterResult;

pub(super) struct PartitionPage {
    pub(super) document_ids: Vec<String>,
    pub(super) cursor: Option<String>,
}

impl LocalCopies {
    pub(super) fn partition_page(
        &self,
        index_name: &str,
        partition_id: u32,
        cursor: Option<String>,
        limit: usize,
    ) -> ClusterResult<PartitionPage> {
        self.refuse_orphaned(index_name)?;
        let params = ListParams {
            cursor,
            limit: Some(limit),
            filters: None,
            document: Some(DocumentProjection::None),
        };
        let page = self
            .engine
            .list_partitions(index_name, &params, &[], &[partition_id])?;
        Ok(PartitionPage {
            document_ids: page.documents.into_iter().map(|listed| listed.id).collect(),
            cursor: page.cursor,
        })
    }

    pub(super) fn stored_entries(
        &self,
        index_name: &str,
        document_ids: Vec<String>,
    ) -> ClusterResult<Vec<(String, Vec<u8>)>> {
        self.refuse_orphaned(index_name)?;
        let copies = PartitionCopies::new(&self.engine);
        let mut stored = Vec::with_capacity(document_ids.len());
        for document_id in document_ids {
            if let Some(document) = copies.document(index_name, &document_id)? {
                let encoded = encode_msgpack(&Value::Object(document))?;
                stored.push((document_id, encoded));
            }
        }
        Ok(stored)
    }
}

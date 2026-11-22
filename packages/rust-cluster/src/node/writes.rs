use narsil::{Map, Value, encode_msgpack};

use super::handle::ClusterNode;
use super::identity::generate_node_id;
use crate::constants::MAX_DOC_ID_LENGTH;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::payload::forward::ForwardKind;
use crate::routing::ClientWrite;

/// The outcome of a batch write: the id of every document that the cluster wrote, and every refused document with
/// its error, each list in the order of the batch.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WriteBatchResult {
    /// The ids of the documents that every in-sync copy of their partition took.
    pub succeeded: Vec<String>,
    /// The documents that the cluster refused, or whose outcome it could not learn.
    pub failed: Vec<WriteBatchFailure>,
}

/// One document of a batch write that the cluster refused, or whose outcome it could not learn.
#[derive(Debug, Clone, PartialEq)]
pub struct WriteBatchFailure {
    /// The id of the document.
    pub document_id: String,
    /// Why the write failed, with the code that a TypeScript node gives for the same failure.
    pub error: ClusterError,
}

fn document_id_refusal(document_id: &str) -> Option<ClusterError> {
    let refused = |message: String| {
        ClusterError::new(codes::DOC_VALIDATION_FAILED, message)
            .with_detail("docId", Value::from(document_id))
    };
    if document_id.is_empty() {
        return Some(refused("Document ID must not be empty".to_string()));
    }
    let length = document_id.encode_utf16().count();
    if length > MAX_DOC_ID_LENGTH {
        return Some(
            refused(format!(
                "Document ID must not exceed {MAX_DOC_ID_LENGTH} characters"
            ))
            .with_detail("length", Value::from(length)),
        );
    }
    if document_id.contains('\0') {
        return Some(refused(
            "Document ID must not contain null bytes".to_string(),
        ));
    }
    None
}

fn embedded_id(document: &Map) -> Option<&str> {
    document
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
}

fn encoded(document: &Map) -> ClusterResult<Vec<u8>> {
    encode_msgpack(&Value::Object(document.clone())).map_err(ClusterError::from)
}

fn insert_write(document: Map, document_id: String) -> ClusterResult<ClientWrite> {
    if let Some(refusal) = document_id_refusal(&document_id) {
        return Err(refusal);
    }
    if let Some(embedded) = embedded_id(&document)
        && embedded != document_id
    {
        return Err(ClusterError::new(
            codes::DOC_VALIDATION_FAILED,
            format!(
                "The call names document id \"{document_id}\" while the document's own id field is \"{embedded}\", so the stored document would contradict the key that it is stored under"
            ),
        )
        .with_detail("docId", Value::from(document_id.as_str()))
        .with_detail("documentId", Value::from(embedded)));
    }
    Ok(ClientWrite {
        document: Some(encoded(&document)?),
        document_id,
        kind: ForwardKind::Insert,
        sent: Some(document),
    })
}

fn update_write(document_id: String, document: &Map) -> ClusterResult<ClientWrite> {
    if let Some(refusal) = document_id_refusal(&document_id) {
        return Err(refusal);
    }
    Ok(ClientWrite {
        document: Some(encoded(document)?),
        document_id,
        kind: ForwardKind::Update,
        sent: None,
    })
}

fn remove_write(document_id: String) -> ClusterResult<ClientWrite> {
    if let Some(refusal) = document_id_refusal(&document_id) {
        return Err(refusal);
    }
    Ok(ClientWrite {
        document: None,
        document_id,
        kind: ForwardKind::Remove,
        sent: None,
    })
}

fn only_outcome(mut outcomes: Vec<Result<(), ClusterError>>) -> ClusterResult<()> {
    outcomes.pop().unwrap_or_else(|| {
        Err(ClusterError::new(
            codes::INTERNAL_ERROR,
            "A write answered no outcome",
        ))
    })
}

impl ClusterNode {
    async fn write_all(
        &self,
        index_name: &str,
        prepared: Vec<(String, ClusterResult<ClientWrite>)>,
    ) -> ClusterResult<WriteBatchResult> {
        let router = self.inner.router()?;
        let mut document_ids = Vec::with_capacity(prepared.len());
        let mut refused: Vec<Option<ClusterError>> = Vec::with_capacity(prepared.len());
        let mut routed = Vec::new();
        for (document_id, write) in prepared {
            document_ids.push(document_id);
            match write {
                Ok(write) => {
                    refused.push(None);
                    routed.push(write);
                }
                Err(error) => refused.push(Some(error)),
            }
        }
        let mut outcomes = router.write(index_name, routed, true).await?.into_iter();
        let mut result = WriteBatchResult::default();
        for (document_id, refusal) in document_ids.into_iter().zip(refused) {
            let outcome = match refusal {
                Some(error) => Err(error),
                None => outcomes.next().unwrap_or_else(|| {
                    Err(ClusterError::new(
                        codes::INTERNAL_ERROR,
                        format!("The write to document '{document_id}' answered no outcome"),
                    ))
                }),
            };
            match outcome {
                Ok(()) => result.succeeded.push(document_id),
                Err(error) => result.failed.push(WriteBatchFailure { document_id, error }),
            }
        }
        Ok(result)
    }

    /// Adds one document to a cluster index, routing it to the primary of the partition that its id hashes to, and
    /// returns the id that the cluster stores it under.
    ///
    /// The id is `document_id` where the caller gives one, else the document's own non-empty string `id` field,
    /// else a new UUID version 7. The node routes the write from the allocation table that it holds, and it reads
    /// the table again only before it retries a write that a primary change refused, as `transport.md` defines.
    ///
    /// # Errors
    ///
    /// Fails with `NODE_NOT_JOINED` before the node joins, with `DOC_VALIDATION_FAILED` where the id is empty,
    /// holds more than 512 UTF-16 code units or a null byte, or differs from the document's own `id` field, with
    /// `INDEX_ORPHANED` where this node keeps an orphaned copy under that name, with `INDEX_NOT_FOUND` where the
    /// cluster holds no such index, with `QUERY_ROUTING_FAILED` where the cluster has yet to allocate it, with
    /// `REPLICATION_OUTCOME_UNKNOWN` where the write may or may not have taken effect, and with the primary's refusal
    /// otherwise.
    pub async fn insert(
        &self,
        index_name: &str,
        document: Map,
        document_id: Option<&str>,
    ) -> ClusterResult<String> {
        let document_id = match document_id.or_else(|| embedded_id(&document)) {
            Some(document_id) => document_id.to_string(),
            None => generate_node_id()?,
        };
        let write = insert_write(document, document_id.clone())?;
        let router = self.inner.router()?;
        only_outcome(router.write(index_name, vec![write], false).await?)?;
        Ok(document_id)
    }

    /// Adds many documents to a cluster index, routing each to the primary of its partition, and reports each
    /// document's outcome in the order of `documents`.
    ///
    /// Each document takes its own non-empty string `id` field as its id, or a new UUID version 7. The node sends
    /// the documents of each partition to that partition's primary in messages of their own, at most 1,000
    /// documents and about 8 MiB of documents to a message, so a primary of several partitions receives at least
    /// one message for each of them. The node retries each refused document on its own, and each partition's
    /// documents wait at most 30 seconds from their first attempt.
    ///
    /// # Errors
    ///
    /// Fails with `NODE_NOT_JOINED` before the node joins, with `INDEX_ORPHANED` where this node keeps an orphaned
    /// copy under that name, with `INDEX_NOT_FOUND` where the cluster holds no such index, and with
    /// `QUERY_ROUTING_FAILED` where the cluster has yet to allocate it. Every other failure is a document's own, in
    /// [`WriteBatchResult::failed`], which holds `QUERY_ROUTING_FAILED` for the documents of a partition whose
    /// index the node finds gone when it routes them again after a primary change.
    pub async fn insert_batch(
        &self,
        index_name: &str,
        documents: Vec<Map>,
    ) -> ClusterResult<WriteBatchResult> {
        let mut prepared = Vec::with_capacity(documents.len());
        for document in documents {
            let document_id = match embedded_id(&document) {
                Some(document_id) => document_id.to_string(),
                None => generate_node_id()?,
            };
            let write = insert_write(document, document_id.clone());
            prepared.push((document_id, write));
        }
        self.write_all(index_name, prepared).await
    }

    /// Replaces a stored document with `document`, which the primary replicates whole to every in-sync copy.
    ///
    /// # Errors
    ///
    /// Fails as [`ClusterNode::insert`] does, and with the primary's `DOC_NOT_FOUND` where the index holds no such
    /// document.
    pub async fn update(
        &self,
        index_name: &str,
        document_id: &str,
        document: Map,
    ) -> ClusterResult<()> {
        let write = update_write(document_id.to_string(), &document)?;
        let router = self.inner.router()?;
        only_outcome(router.write(index_name, vec![write], false).await?)
    }

    /// Replaces many stored documents, each with the whole document paired with its id, and reports each one's
    /// outcome in the order of `updates`.
    ///
    /// # Errors
    ///
    /// Fails as [`ClusterNode::insert_batch`] does.
    pub async fn update_batch(
        &self,
        index_name: &str,
        updates: Vec<(String, Map)>,
    ) -> ClusterResult<WriteBatchResult> {
        let prepared = updates
            .into_iter()
            .map(|(document_id, document)| {
                let write = update_write(document_id.clone(), &document);
                (document_id, write)
            })
            .collect();
        self.write_all(index_name, prepared).await
    }

    /// Removes one document from a cluster index.
    ///
    /// # Errors
    ///
    /// Fails as [`ClusterNode::update`] does.
    pub async fn remove(&self, index_name: &str, document_id: &str) -> ClusterResult<()> {
        let write = remove_write(document_id.to_string())?;
        let router = self.inner.router()?;
        only_outcome(router.write(index_name, vec![write], false).await?)
    }

    /// Removes many documents from a cluster index and reports each one's outcome in the order of `document_ids`.
    ///
    /// # Errors
    ///
    /// Fails as [`ClusterNode::insert_batch`] does.
    pub async fn remove_batch(
        &self,
        index_name: &str,
        document_ids: Vec<String>,
    ) -> ClusterResult<WriteBatchResult> {
        let prepared = document_ids
            .into_iter()
            .map(|document_id| {
                let write = remove_write(document_id.clone());
                (document_id, write)
            })
            .collect();
        self.write_all(index_name, prepared).await
    }
}

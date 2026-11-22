use super::fields::fields_of;
use crate::wire::{write_map_header, write_str, write_uint};

pub(crate) fn acknowledged_seq_no(
    payload: &[u8],
    index_name: &str,
    partition_id: u32,
) -> Option<u64> {
    let [seq_no, answered_partition, answered_index] =
        fields_of(payload, ["seqNo", "partitionId", "indexName"])?;
    if answered_index.text()? != index_name || answered_partition.count_u32()? != partition_id {
        return None;
    }
    seq_no.count()
}

pub(crate) fn encode_insync_remove(
    index_name: &str,
    partition_id: u32,
    replica_node_id: &str,
    primary_term: u64,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(index_name.len() + replica_node_id.len() + 80);
    write_map_header(&mut out, 4);
    write_str(&mut out, "indexName");
    write_str(&mut out, index_name);
    write_str(&mut out, "partitionId");
    write_uint(&mut out, u64::from(partition_id));
    write_str(&mut out, "replicaNodeId");
    write_str(&mut out, replica_node_id);
    write_str(&mut out, "primaryTerm");
    write_uint(&mut out, primary_term);
    out
}

pub(crate) fn encode_primary_resign(
    index_name: &str,
    index_uuid: &str,
    partition_id: u32,
    primary_term: u64,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(index_name.len() + index_uuid.len() + 72);
    write_map_header(&mut out, 4);
    write_str(&mut out, "indexName");
    write_str(&mut out, index_name);
    write_str(&mut out, "indexUuid");
    write_str(&mut out, index_uuid);
    write_str(&mut out, "partitionId");
    write_uint(&mut out, u64::from(partition_id));
    write_str(&mut out, "primaryTerm");
    write_uint(&mut out, primary_term);
    out
}

pub(crate) fn insync_confirmed(payload: &[u8]) -> Option<bool> {
    let [index_name, partition_id, accepted] =
        fields_of(payload, ["indexName", "partitionId", "accepted"])?;
    index_name.text()?;
    partition_id.count()?;
    accepted.flag()
}

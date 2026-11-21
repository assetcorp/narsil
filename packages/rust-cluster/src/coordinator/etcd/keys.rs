use crate::constants::{INDEX_METADATA_KEY_PREFIX, INDEX_METADATA_KEY_SUFFIX};

const NODES: &str = "nodes";
const NODE_STARTED_AT: &str = "node-started-at";
const ALLOCATION: &str = "allocation";
const PARTITION: &str = "partition";
const SCHEMA: &str = "schema";
const LEASE: &str = "lease";
const GENERIC: &str = "kv";

#[derive(Debug, Clone)]
pub(crate) struct CoordinatorKeys {
    prefix: String,
}

impl CoordinatorKeys {
    pub(crate) fn new(prefix: &str) -> CoordinatorKeys {
        CoordinatorKeys {
            prefix: prefix.to_string(),
        }
    }

    fn build(&self, segments: &[&str]) -> String {
        let mut key = self.prefix.clone();
        for segment in segments {
            key.push('/');
            key.push_str(segment);
        }
        key
    }

    pub(crate) fn node(&self, node_id: &str) -> String {
        self.build(&[NODES, node_id])
    }

    pub(crate) fn node_started_at(&self, node_id: &str) -> String {
        self.build(&[NODE_STARTED_AT, node_id])
    }

    pub(crate) fn node_prefix(&self) -> String {
        self.build(&[NODES, ""])
    }

    pub(crate) fn allocation(&self, index_name: &str) -> String {
        self.build(&[ALLOCATION, index_name])
    }

    pub(crate) fn allocation_prefix(&self) -> String {
        self.build(&[ALLOCATION, ""])
    }

    pub(crate) fn partition(&self, index_name: &str, partition_id: u64) -> String {
        self.build(&[PARTITION, index_name, &partition_id.to_string()])
    }

    pub(crate) fn schema(&self, index_name: &str) -> String {
        self.build(&[SCHEMA, index_name])
    }

    pub(crate) fn schema_prefix(&self) -> String {
        self.build(&[SCHEMA, ""])
    }

    pub(crate) fn lease(&self, key: &str) -> String {
        self.build(&[LEASE, key])
    }

    pub(crate) fn generic(&self, key: &str) -> String {
        self.build(&[GENERIC, key])
    }
}

pub(crate) fn suffix_after<'a>(full_key: &'a str, prefix: &str) -> &'a str {
    full_key.strip_prefix(prefix).unwrap_or_default()
}

pub(crate) fn index_name_of_metadata_suffix(suffix: &str) -> Option<&str> {
    let index_name = suffix.strip_suffix(INDEX_METADATA_KEY_SUFFIX)?;
    (!index_name.is_empty() && !index_name.contains('/')).then_some(index_name)
}

pub(crate) fn index_metadata_prefix(keys: &CoordinatorKeys) -> String {
    keys.generic(INDEX_METADATA_KEY_PREFIX)
}

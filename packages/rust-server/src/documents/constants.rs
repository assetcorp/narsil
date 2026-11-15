pub(crate) const MAX_PARTITIONS: f64 = 65_536.0;
pub(crate) const MIN_HNSW_M: f64 = 2.0;
pub(crate) const MAX_HNSW_M: f64 = 512.0;
pub(crate) const MAX_BM25_K1: f64 = 1_000.0;
pub(crate) const MAX_BM25_B: f64 = 1.0;
pub(crate) const BM25_DISPLAYED_NAME_UNITS: usize = 64;

pub(crate) const RESPONSE_GROUP_DOCUMENTS: usize = 64;
pub(crate) const RESPONSE_GROUP_BYTES: usize = 256 * 1024;
pub(crate) const RESPONSE_GROUPS_IN_FLIGHT: usize = 4;

pub(crate) const DEFAULT_PROMOTION_THRESHOLD: u64 = 1_024;
pub(crate) const DEFAULT_FILTER_THRESHOLD: f64 = 0.03;
pub(crate) const DEFAULT_M: u32 = 16;
pub(crate) const MIN_M: u32 = 2;
pub(crate) const DEFAULT_EF_CONSTRUCTION: u32 = 200;
pub(crate) const OSQ4_MIN_DIMENSION: usize = 384;

pub(crate) const MAX_VECTOR_ORDINALS: u32 = 16_777_216;
pub(crate) const MAX_LAYER_CAP: u8 = 32;
pub(crate) const UPPER_LISTS_PER_NODE_BOUND: u128 = 4;
pub(crate) const UPPER_LIST_ALLOWANCE: u128 = 64;
pub(crate) const VECTORS_PER_BLOCK: u32 = 1_024;
pub(crate) const MIN_ORDINAL_CAPACITY: usize = 1_024;
pub(crate) const MIN_UPPER_WORDS: usize = 4_096;
pub(crate) const MIN_ID_TABLE_SLOTS: usize = 2_048;
pub(crate) const ID_TABLE_MAX_LOAD_PERCENT: usize = 50;
pub(crate) const DOC_ID_CHUNK_ORDINALS: usize = 4_096;

pub(crate) const SCORE_CHUNK_VECTORS: usize = 4_096;
pub(crate) const BUILD_CHUNK_VECTORS: usize = 64;
pub(crate) const BUILD_CHUNKS_PER_THREAD: usize = 2;
pub(crate) const PARALLEL_BUILD_MIN_VECTORS: u64 = 128;
pub(crate) const RECALIBRATION_CHUNK_VECTORS: usize = 512;
pub(crate) const LOCK_SPIN_ITERATIONS: u32 = 128;

pub(crate) const DEFAULT_EF_SEARCH: usize = 50;
pub(crate) const MIN_EF_SEARCH: usize = 1;
pub(crate) const MAX_EF_SEARCH: usize = 10_000;
pub(crate) const MAX_SEARCH_K: usize = 10_000;
pub(crate) const MIN_RESCORE_WINDOW: usize = 1;
pub(crate) const MAX_RESCORE_WINDOW: usize = 10_000;
pub(crate) const OVERSAMPLED_DEPTH_CAP: usize = 10_000;
pub(crate) const MIN_OVERSAMPLE: f64 = 1.0;
pub(crate) const NARROW_DIMENSION_LIMIT: usize = 768;
pub(crate) const WIDE_DIMENSION_LIMIT: usize = 1_024;
pub(crate) const EF_SEARCH_MARGIN_NARROW: usize = 50;
pub(crate) const EF_SEARCH_MARGIN_MIDDLE: usize = 75;
pub(crate) const EF_SEARCH_MARGIN_WIDE: usize = 0;
pub(crate) const OSQ2_MIDDLE_RESCORE_DEPTH_WITHIN_WALK_PER_SQUARE_ROOT_OF_LIMIT: f64 = 18.0;
pub(crate) const RESCORE_DEPTH_FLOOR_PER_LIMIT_OSQ1: usize = 3;
pub(crate) const RESCORE_DEPTH_FLOOR_PER_LIMIT_OSQ2: usize = 3;
pub(crate) const RESCORE_DEPTH_FLOOR_PER_LIMIT_OSQ4: usize = 1;
pub(crate) const RESCORE_DEPTH_FLOOR_PER_LIMIT_OSQ8: usize = 1;
pub(crate) const RESCORE_DEPTH_OSQ1: [(f64, f64); 3] = [(3.23, 55.9), (2.2, 27.0), (3.0, 0.0)];
pub(crate) const RESCORE_DEPTH_OSQ2: [(f64, f64); 3] = [(2.6, 22.5), (1.0, 16.0), (3.0, 0.0)];
pub(crate) const RESCORE_DEPTH_OSQ4: [(f64, f64); 3] = [(5.0, 0.0), (5.0, 0.0), (2.0, 0.0)];
pub(crate) const RESCORE_DEPTH_OSQ8: [(f64, f64); 3] = [(2.0, 0.0), (2.0, 0.0), (2.0, 0.0)];

pub(crate) const ESTIMATED_MS_PER_TOMBSTONE: f64 = 0.05;
pub(crate) const ESTIMATED_MS_PER_VECTOR_REBUILD: f64 = 0.15;
pub(crate) const DIMENSIONS_PER_ESTIMATE_UNIT: f64 = 256.0;
pub(crate) const REBUILD_REMOVED_RATIO: f64 = 0.2;
pub(crate) const DRIFT_CHECK_GROWTH_FACTOR: u64 = 2;
pub(crate) const RECALIBRATION_DRIFT_RATIO: f64 = 2.5;

pub(crate) const COLD_LOAD_WAIT_WITHOUT_SEARCH_MS: u64 = 400;
pub(crate) const COLD_REPLAY_ROUNDS_BESIDE_SEARCHES: usize = 8;
pub(crate) const COLD_WRITES_REPLAYED_WHILE_SEARCHES_WAIT: usize = 256;

pub(crate) const VECTOR_FILE_REPLACED_ABOVE_DEAD_SHARE: f64 = 0.2;
pub(crate) const VECTOR_FILE_FIXED_OVERHEAD_BYTES: u64 = 65_536;
pub(crate) const VECTOR_FILE_STRING_HEADER_BYTES: u64 = 5;
pub(crate) const VECTOR_FILE_CENTROID_BYTES_PER_COMPONENT: u64 = 9;
pub(crate) const MAX_DOC_ID_UTF8_BYTES_PER_UNIT: u64 = 3;

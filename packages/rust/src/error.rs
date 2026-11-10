use std::fmt;

macro_rules! error_codes {
    ($($(#[$doc:meta])* $name:ident),* $(,)?) => {
        /// The code of a [`NarsilError`], with the same spelling as the error codes of the Narsil specification.
        ///
        /// A program that branches on the cause of a failure matches on this code, because the message
        /// can change between releases while the code stays fixed.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        #[non_exhaustive]
        #[allow(non_camel_case_types)]
        pub enum ErrorCode {
            $($(#[$doc])* $name,)*
        }

        impl ErrorCode {
            /// Returns the code as the specification spells it, such as `DOC_NOT_FOUND`.
            pub fn as_str(self) -> &'static str {
                match self {
                    $(ErrorCode::$name => stringify!($name),)*
                }
            }

            /// Returns the code that the specification spells as `name`, or `None` for a name that this crate never raises.
            pub fn from_name(name: &str) -> Option<ErrorCode> {
                match name {
                    $(stringify!($name) => Some(ErrorCode::$name),)*
                    _ => None,
                }
            }
        }
    };
}

error_codes! {
    /// A schema names an unknown type, an option outside its base type, or too many text fields.
    SCHEMA_INVALID_TYPE,
    /// A schema nests deeper than the engine allows.
    SCHEMA_DEPTH_EXCEEDED,
    /// A `vector[n]` field gives a dimension outside the allowed range.
    SCHEMA_INVALID_VECTOR_DIMENSION,
    /// A geopoint value is outside the valid range of latitude and longitude.
    SCHEMA_INVALID_GEOPOINT,
    /// The index holds no document with the requested ID.
    DOC_NOT_FOUND,
    /// The index already holds a document with the requested ID.
    DOC_ALREADY_EXISTS,
    /// A document breaks the schema or a limit of the specification.
    DOC_VALIDATION_FAILED,
    /// The engine holds no index with the requested name.
    INDEX_NOT_FOUND,
    /// The engine already holds an index with the requested name.
    INDEX_ALREADY_EXISTS,
    /// An operation names a closed index that already has the configured number of operations waiting for it.
    INDEX_REOPEN_CAPACITY_EXHAUSTED,
    /// The engine has shut down and refuses new work.
    INSTANCE_SHUT_DOWN,
    /// A write arrived while a rebalance queue was full.
    PARTITION_REBALANCING_BACKPRESSURE,
    /// A worker thread stopped while it held work.
    WORKER_CRASHED,
    /// Every thread slot of the process is in use, so the engine cannot serve another thread until one ends.
    WORKER_BUSY,
    /// A worker thread still held the old index when the engine stopped waiting for it.
    WORKER_TIMEOUT,
    /// A task that the engine runs apart from its caller failed, such as a merge of query history that passed its
    /// memory limit.
    WORKER_ACTION_FAILED,
    /// The engine cannot write a snapshot or log file.
    PERSISTENCE_SAVE_FAILED,
    /// The engine cannot read or decode a snapshot or log file.
    PERSISTENCE_LOAD_FAILED,
    /// The engine cannot delete a persisted file.
    PERSISTENCE_DELETE_FAILED,
    /// A checksum differs from the bytes that it covers.
    PERSISTENCE_CRC_MISMATCH,
    /// A record inside the durable region of the write-ahead log is damaged or missing.
    PERSISTENCE_WAL_CORRUPT,
    /// An fsync returned an error, so the engine acknowledges no write that the fsync covers.
    PERSISTENCE_FSYNC_FAILED,
    /// A backup manifest is damaged.
    BACKUP_DAMAGED,
    /// Device sync needs write-ahead log durability.
    SYNC_DURABILITY_REQUIRED,
    /// Device sync is off for the index.
    SYNC_NOT_ENABLED,
    /// Popular query suggestions are off for the index.
    QUERY_SUGGESTIONS_NOT_ENABLED,
    /// A partition's in-memory state broke one of the engine's own rules.
    PARTITION_CORRUPTED,
    /// The text analysis generation that a file names is missing from the index.
    ANALYSIS_GENERATION_MISSING,
    /// A plugin hook failed.
    HOOK_ERROR,
    /// The engine failed in a way that no other code describes.
    INTERNAL_ERROR,
    /// A query names a field that the schema lacks or that cannot serve the request.
    SEARCH_INVALID_FIELD,
    /// A vector has a dimension other than the one that its field declares.
    VECTOR_DIMENSION_MISMATCH,
    /// A filter is malformed or crosses a filter limit.
    SEARCH_INVALID_FILTER,
    /// A query asks for a search mode that the index cannot serve.
    SEARCH_INVALID_MODE,
    /// A search cursor is malformed or belongs to another query.
    SEARCH_INVALID_CURSOR,
    /// A query asks for results beyond the result window.
    SEARCH_RESULT_WINDOW_EXCEEDED,
    /// A query counted more work than the work cap allows.
    SEARCH_WORK_CAP_EXCEEDED,
    /// A quoted phrase is malformed.
    SEARCH_INVALID_PHRASE,
    /// A phrase query reached an index that tracks no positions.
    SEARCH_PHRASE_NOT_READY,
    /// The engine holds no language module of the requested name.
    LANGUAGE_NOT_SUPPORTED,
    /// A file has a format version, compression, or encryption that this release cannot read.
    ENVELOPE_VERSION_MISMATCH,
    /// A file does not begin with the `NRSL` magic bytes.
    ENVELOPE_INVALID_MAGIC,
    /// An index has reached its partition limit.
    PARTITION_CAPACITY_EXCEEDED,
    /// A restore needs more memory than the process has free.
    RESTORE_MEMORY_EXCEEDED,
    /// The engine blocks writes while its memory is above the configured limit.
    MEMORY_WRITE_BLOCKED,
    /// A later analysis change replaced this one before it finished.
    ANALYSIS_CHANGE_REPLACED,
    /// An analysis change is still building.
    ANALYSIS_CHANGE_NOT_READY,
    /// The rebuild of an index's analysis needs more memory than the process has free.
    ANALYSIS_REBUILD_MEMORY_EXCEEDED,
    /// An embedding adapter failed.
    EMBEDDING_FAILED,
    /// An embedding adapter returned a vector of the wrong dimension.
    EMBEDDING_DIMENSION_MISMATCH,
    /// A document gives no text for an embedded vector field.
    EMBEDDING_NO_SOURCE,
    /// The embedding configuration is invalid or names a missing adapter.
    EMBEDDING_CONFIG_INVALID,
    /// A rerank adapter failed.
    RERANK_FAILED,
    /// The rerank configuration is invalid or names a missing adapter.
    RERANK_CONFIG_INVALID,
    /// A document leaves out a field that the index requires.
    DOC_MISSING_REQUIRED_FIELD,
    /// A configuration value is invalid.
    CONFIG_INVALID,
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// The error that every fallible operation of this crate returns.
///
/// The [`code`](NarsilError::code) names the rule that the operation broke, with the spelling that every
/// Narsil implementation uses, and the message says what happened in words.
#[derive(Debug, Clone, PartialEq)]
pub struct NarsilError {
    code: ErrorCode,
    message: String,
}

impl NarsilError {
    /// Builds an error with `code` and a message for a person to read.
    pub fn new(code: ErrorCode, message: impl Into<String>) -> NarsilError {
        NarsilError {
            code,
            message: message.into(),
        }
    }

    /// Returns the code that names the rule that the operation broke.
    pub fn code(&self) -> ErrorCode {
        self.code
    }

    /// Returns the message for a person to read.
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for NarsilError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for NarsilError {}

/// The result of every fallible operation of this crate.
pub type Result<T, E = NarsilError> = std::result::Result<T, E>;

pub(crate) fn fail<T>(code: ErrorCode, message: impl Into<String>) -> Result<T> {
    Err(NarsilError::new(code, message))
}

pub(crate) fn load_failed<T>(message: impl Into<String>) -> Result<T> {
    fail(ErrorCode::PERSISTENCE_LOAD_FAILED, message)
}

package engine

import "github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"

const (
	// CodeSchemaInvalidType reports a schema field whose type the engine does not know.
	CodeSchemaInvalidType = narsilerr.CodeSchemaInvalidType
	// CodeSchemaDepthExceeded reports a schema nested deeper than the engine allows.
	CodeSchemaDepthExceeded = narsilerr.CodeSchemaDepthExceeded
	// CodeSchemaInvalidVectorDimension reports a vector field whose dimension is out of range.
	CodeSchemaInvalidVectorDimension = narsilerr.CodeSchemaInvalidVectorDimension
	// CodeSchemaInvalidGeopoint reports a geopoint value without a usable latitude and longitude.
	CodeSchemaInvalidGeopoint = narsilerr.CodeSchemaInvalidGeopoint
	// CodeDocNotFound reports a document ID that the index does not hold.
	CodeDocNotFound = narsilerr.CodeDocNotFound
	// CodeDocAlreadyExists reports an insert under a document ID that the index already holds.
	CodeDocAlreadyExists = narsilerr.CodeDocAlreadyExists
	// CodeDocValidationFailed reports a document, an ID, or a query value that the schema refuses.
	CodeDocValidationFailed = narsilerr.CodeDocValidationFailed
	// CodeIndexNotFound reports an index name that the engine does not hold.
	CodeIndexNotFound = narsilerr.CodeIndexNotFound
	// CodeIndexAlreadyExists reports a create under an index name that the engine already holds.
	CodeIndexAlreadyExists = narsilerr.CodeIndexAlreadyExists
	// CodeIndexOrphaned reports an index whose files outlived the engine that held them.
	CodeIndexOrphaned = narsilerr.CodeIndexOrphaned
	// CodeIndexReopenCapacityExhausted reports more callers waiting for a closed index than the engine admits.
	CodeIndexReopenCapacityExhausted = narsilerr.CodeIndexReopenCapacityExhausted
	// CodeInstanceShutDown reports a call made after Shutdown started.
	CodeInstanceShutDown = narsilerr.CodeInstanceShutDown
	// CodePartitionCorrupted reports a partition whose state the engine cannot trust.
	CodePartitionCorrupted = narsilerr.CodePartitionCorrupted
	// CodePartitionRebalancingBackpressure reports a write refused while a rebalance holds too many queued writes.
	CodePartitionRebalancingBackpressure = narsilerr.CodePartitionRebalancingBackpressure
	// CodeWorkerCrashed reports a worker that stopped while it held work.
	CodeWorkerCrashed = narsilerr.CodeWorkerCrashed
	// CodeWorkerBusy reports a worker that could not take more work.
	CodeWorkerBusy = narsilerr.CodeWorkerBusy
	// CodeWorkerTimeout reports a worker that did not answer in time.
	CodeWorkerTimeout = narsilerr.CodeWorkerTimeout
	// CodeWorkerActionFailed reports a worker that failed the work it was given.
	CodeWorkerActionFailed = narsilerr.CodeWorkerActionFailed
	// CodePersistenceSaveFailed reports a file or a key that the engine could not write.
	CodePersistenceSaveFailed = narsilerr.CodePersistenceSaveFailed
	// CodePersistenceLoadFailed reports a file or a key that the engine could not read or trust.
	CodePersistenceLoadFailed = narsilerr.CodePersistenceLoadFailed
	// CodePersistenceDeleteFailed reports a file or a key that the engine could not remove.
	CodePersistenceDeleteFailed = narsilerr.CodePersistenceDeleteFailed
	// CodePersistenceCrcMismatch reports a file whose checksum differs from its contents.
	CodePersistenceCrcMismatch = narsilerr.CodePersistenceCrcMismatch
	// CodePersistenceWalCorrupt reports a write-ahead log record that the engine cannot replay.
	CodePersistenceWalCorrupt = narsilerr.CodePersistenceWalCorrupt
	// CodePersistenceFsyncFailed reports a write that the disk did not confirm.
	CodePersistenceFsyncFailed = narsilerr.CodePersistenceFsyncFailed
	// CodePersistenceDependencyMissing reports a persistence feature whose dependency is absent.
	CodePersistenceDependencyMissing = narsilerr.CodePersistenceDependencyMissing
	// CodeBackupNotFound reports a backup that the store does not hold.
	CodeBackupNotFound = narsilerr.CodeBackupNotFound
	// CodeBackupAlreadyExists reports a backup name that the store already holds.
	CodeBackupAlreadyExists = narsilerr.CodeBackupAlreadyExists
	// CodeBackupDamaged reports a backup whose files fail their checks.
	CodeBackupDamaged = narsilerr.CodeBackupDamaged
	// CodeBackupDurabilityRequired reports a backup asked of an engine without durability.
	CodeBackupDurabilityRequired = narsilerr.CodeBackupDurabilityRequired
	// CodeBackupInProgress reports a backup asked while another one runs.
	CodeBackupInProgress = narsilerr.CodeBackupInProgress
	// CodeBackupStoreClaimed reports a backup store that another engine holds.
	CodeBackupStoreClaimed = narsilerr.CodeBackupStoreClaimed
	// CodeBackupStoreNotConfigured reports a backup asked of an engine with no backup store.
	CodeBackupStoreNotConfigured = narsilerr.CodeBackupStoreNotConfigured
	// CodeBackupNotReady reports a backup that is not finished yet.
	CodeBackupNotReady = narsilerr.CodeBackupNotReady
	// CodeSyncDurabilityRequired reports device sync asked of an engine without durability.
	CodeSyncDurabilityRequired = narsilerr.CodeSyncDurabilityRequired
	// CodeSyncBackupStoreRequired reports device sync asked of an engine with no backup store.
	CodeSyncBackupStoreRequired = narsilerr.CodeSyncBackupStoreRequired
	// CodeSyncNotReady reports device sync that is still starting.
	CodeSyncNotReady = narsilerr.CodeSyncNotReady
	// CodeSyncNotEnabled reports a sync call on an index whose sync is off.
	CodeSyncNotEnabled = narsilerr.CodeSyncNotEnabled
	// CodeSyncSnapshotPreparing reports a sync snapshot that is still being built.
	CodeSyncSnapshotPreparing = narsilerr.CodeSyncSnapshotPreparing
	// CodeQuerySuggestionsNotEnabled reports a popular query call on an index whose suggestions are off.
	CodeQuerySuggestionsNotEnabled = narsilerr.CodeQuerySuggestionsNotEnabled
	// CodeSearchInvalidField reports a query that names a field the schema cannot search that way.
	CodeSearchInvalidField = narsilerr.CodeSearchInvalidField
	// CodeVectorDimensionMismatch reports a vector whose length differs from its field's dimension.
	CodeVectorDimensionMismatch = narsilerr.CodeVectorDimensionMismatch
	// CodeSearchInvalidFilter reports a filter that the schema cannot answer.
	CodeSearchInvalidFilter = narsilerr.CodeSearchInvalidFilter
	// CodeSearchInvalidMode reports a search mode that the query cannot run.
	CodeSearchInvalidMode = narsilerr.CodeSearchInvalidMode
	// CodeSearchInvalidCursor reports a page cursor that this query did not produce.
	CodeSearchInvalidCursor = narsilerr.CodeSearchInvalidCursor
	// CodeSearchResultWindowExceeded reports a page that ends beyond the result window.
	CodeSearchResultWindowExceeded = narsilerr.CodeSearchResultWindowExceeded
	// CodeSearchWorkCapExceeded reports a pattern search that needed more work than the cap allows.
	CodeSearchWorkCapExceeded = narsilerr.CodeSearchWorkCapExceeded
	// CodeSearchInvalidPhrase reports a quoted phrase that the index cannot match.
	CodeSearchInvalidPhrase = narsilerr.CodeSearchInvalidPhrase
	// CodeSearchPhraseNotReady reports a phrase query on an index whose positions are being rebuilt.
	CodeSearchPhraseNotReady = narsilerr.CodeSearchPhraseNotReady
	// CodeBm25NotReady reports BM25 settings that the engine cannot apply yet.
	CodeBm25NotReady = narsilerr.CodeBm25NotReady
	// CodeLanguageNotSupported reports a language that the engine has no analyser for.
	CodeLanguageNotSupported = narsilerr.CodeLanguageNotSupported
	// CodeEnvelopeVersionMismatch reports a file in a format version this release does not read.
	CodeEnvelopeVersionMismatch = narsilerr.CodeEnvelopeVersionMismatch
	// CodeEnvelopeInvalidMagic reports a file that does not open with the Narsil magic bytes.
	CodeEnvelopeInvalidMagic = narsilerr.CodeEnvelopeInvalidMagic
	// CodePartitionCapacityExceeded reports an insert into an index or a partition that is full.
	CodePartitionCapacityExceeded = narsilerr.CodePartitionCapacityExceeded
	// CodeRestoreMemoryExceeded reports a restore that needs more memory than the process has free.
	CodeRestoreMemoryExceeded = narsilerr.CodeRestoreMemoryExceeded
	// CodeMemoryWriteBlocked reports a write refused while memory use stays above the block level.
	CodeMemoryWriteBlocked = narsilerr.CodeMemoryWriteBlocked
	// CodeAnalysisChangeReplaced reports an analysis change that a later change replaced.
	CodeAnalysisChangeReplaced = narsilerr.CodeAnalysisChangeReplaced
	// CodeAnalysisChangeNotReady reports an analysis change that is still building.
	CodeAnalysisChangeNotReady = narsilerr.CodeAnalysisChangeNotReady
	// CodeAnalysisGenerationMissing reports saved terms whose analysis generation the metadata lacks.
	CodeAnalysisGenerationMissing = narsilerr.CodeAnalysisGenerationMissing
	// CodeAnalysisRebuildMemoryExceeded reports an analysis rebuild that needs more memory than is free.
	CodeAnalysisRebuildMemoryExceeded = narsilerr.CodeAnalysisRebuildMemoryExceeded
	// CodeEmbeddingFailed reports an embedding adapter that failed or returned an unusable vector.
	CodeEmbeddingFailed = narsilerr.CodeEmbeddingFailed
	// CodeEmbeddingDimensionMismatch reports an embedding whose length differs from its target field.
	CodeEmbeddingDimensionMismatch = narsilerr.CodeEmbeddingDimensionMismatch
	// CodeEmbeddingNoSource reports a document whose embedding source fields are all empty.
	CodeEmbeddingNoSource = narsilerr.CodeEmbeddingNoSource
	// CodeEmbeddingConfigInvalid reports embedding settings or an adapter that the engine refuses.
	CodeEmbeddingConfigInvalid = narsilerr.CodeEmbeddingConfigInvalid
	// CodeRerankFailed reports a rerank adapter that failed or returned unusable scores.
	CodeRerankFailed = narsilerr.CodeRerankFailed
	// CodeRerankConfigInvalid reports rerank settings or an adapter that the engine refuses.
	CodeRerankConfigInvalid = narsilerr.CodeRerankConfigInvalid
	// CodeDocMissingRequiredField reports a document without a field that the index requires.
	CodeDocMissingRequiredField = narsilerr.CodeDocMissingRequiredField
	// CodeConfigInvalid reports engine or index settings that the engine refuses.
	CodeConfigInvalid = narsilerr.CodeConfigInvalid
)

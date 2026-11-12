package engine

import "github.com/assetcorp/narsil/packages/go/engine/internal/model"

// QueryCoverage reports how many partitions answered a query.
type QueryCoverage = model.QueryCoverage

// ScoreComponents holds the term figures behind a keyword score.
type ScoreComponents = model.ScoreComponents

// HighlightPosition is the start and end of one marked match in a snippet.
type HighlightPosition = model.HighlightPosition

// HighlightMatch is a snippet of one field with its marked matches.
type HighlightMatch = model.HighlightMatch

// Hit is one ranked document of a query result.
type Hit = model.Hit

// FacetCount is one facet value with the number of documents that hold it.
type FacetCount = model.FacetCount

// FacetResult holds the counted values of one faceted field.
type FacetResult = model.FacetResult

// GroupResult holds the hits that share one set of group values.
type GroupResult = model.GroupResult

// QueryResult holds the hits of a query, the match count, any facets and
// groups, the cursor for the next page, and the time the query took.
type QueryResult = model.QueryResult

// PreflightResult holds the match count of a query that built no hits.
type PreflightResult = model.PreflightResult

// BatchFailure is one document of a batch that the engine refused, with the reason.
type BatchFailure = model.BatchFailure

// BatchResult lists the documents of a batch that the engine wrote and the ones it refused.
type BatchResult = model.BatchResult

// ImportRefusal is one line of a document export that the engine refused.
type ImportRefusal = model.ImportRefusal

// DocumentImportResult counts the imported documents and the refused lines of an import.
type DocumentImportResult = model.DocumentImportResult

// IndexStats holds the document count, partition count, memory estimate,
// language, and schema of one index, with its saved size and log size where
// durability records them.
type IndexStats = model.IndexStats

// IndexState reports whether an index is loaded.
type IndexState = model.IndexState

const (
	// IndexOpen marks an index that the engine holds in memory.
	IndexOpen = model.IndexOpen
	// IndexClosed marks an index that the engine loads on its next request.
	IndexClosed = model.IndexClosed
	// IndexReopenFailed marks an index whose last load failed.
	IndexReopenFailed = model.IndexReopenFailed
)

// IndexInfo describes one index that ListIndexes returns.
type IndexInfo = model.IndexInfo

// PartitionStatsResult holds the document count, memory estimate, saved size,
// and log size of one partition.
type PartitionStatsResult = model.PartitionStatsResult

// SuggestedTerm is one completion of a prefix with the number of documents that hold it.
type SuggestedTerm = model.SuggestedTerm

// SuggestResult holds the completions of a prefix.
type SuggestResult = model.SuggestResult

// VectorMaintenanceResult reports the state of one vector field's graph.
type VectorMaintenanceResult = model.VectorMaintenanceResult

// ListedDocument is one document of a ListDocuments page.
type ListedDocument = model.ListedDocument

// ListResult holds one page of ListDocuments with the cursor for the next.
type ListResult = model.ListResult

// ProcessMemoryReport holds the memory figures of the Go process.
type ProcessMemoryReport = model.ProcessMemoryReport

// WorkerCopyReport describes whether an index serves its queries from the worker pool.
type WorkerCopyReport = model.WorkerCopyReport

// HeldCheckpointReport describes an index whose checkpoint the engine is holding back.
type HeldCheckpointReport = model.HeldCheckpointReport

// WorkerMemoryReport holds the memory figures of one query worker.
type WorkerMemoryReport = model.WorkerMemoryReport

// MemoryStats holds what the engine and its process use, for sizing a host.
type MemoryStats = model.MemoryStats

// WriteOptions sets how a write waits.
type WriteOptions = model.WriteOptions

// InsertOptions sets how an insert waits.
type InsertOptions = model.InsertOptions

// DocumentUpdate is one entry of UpdateBatch: the ID and the replacement
// document. Set Fields in place of Document to store the replacement with
// the key order that the Fields holds; UpdateBatch reads Fields when it is
// not nil and Document otherwise.
type DocumentUpdate = model.DocumentUpdate

// SnapshotOptions sets what Snapshot adds to the archive beyond the checkpoint.
type SnapshotOptions = model.SnapshotOptions

// SyncSetting turns device sync on or off for an index and bounds its history.
type SyncSetting = model.SyncSetting

// SyncStatus reports the sync setting of an index and whether sync is active.
type SyncStatus = model.SyncStatus

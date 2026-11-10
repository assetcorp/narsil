package persist

import "time"

const (
	DefaultCheckpointInterval            = 300_000 * time.Millisecond
	DefaultCheckpointMutationThreshold   = 100_000
	DefaultAsyncFlushInterval            = 1_000 * time.Millisecond
	DirectoryIdentityCheckInterval       = 1_000 * time.Millisecond
	RecoveryInsertBatchDocuments         = 1_024
	SingleNodePrimaryTerm                = 1
	MaxImportRefusalsReported            = 1_000
	ImportBatchDocuments                 = 1_000
	MaxIndexNameLength                   = 255
	restoreSuffixRandomBytes             = 8
	EarlierReleaseMinGraphM              = 1
	WritesStallAboveUncheckpointedBytes  = 2_147_483_648
	LogRecordsPerCheckpoint              = 100_000
	WholePartitionMinChangedShare        = 0.5
	WholePartitionLargestDocumentCount   = 100_000
	DefaultCompactionThreshold           = 12
	CompactionLargestMergedDocumentCount = 200_000
	SegmentFileFramingSlackBytes         = 65_536
	MergedSegmentTargetBytes             = 1_073_741_824
	MergedSegmentGrowthAllowance         = 1.01
	ColdLoadWaitWithoutSearch            = 400 * time.Millisecond
)

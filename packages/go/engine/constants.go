package engine

import (
	"math"
	"time"
)

const (
	maxIndexNameLength           = 255
	batchChunkSize               = 1000
	arrayPositionGap             = 100
	defaultLanguage              = "english"
	defaultBM25K1                = 1.2
	defaultBM25B                 = 0.75
	maxBM25K1                    = 1000
	maxBM25B                     = 1
	bm25DisplayedNameLength      = 64
	defaultPromotionThreshold    = 1000
	minWorkerCount               = 2
	maxWorkerCount               = 8
	maxRequestedWorkerCount      = 31
	heapPressureWarningFraction  = 0.9
	heapPressureRearmFraction    = 0.8
	defaultBlockWritesAbove      = 0.9
	defaultResumeWritesBelow     = 0.8
	heapMeasureMaxAge            = time.Second
	unlimitedMemoryLimit         = math.MaxInt64
	embeddingConcurrency         = 8
	engineVersion                = "0.1.0"
	exportHeaderHolder           = "document export header"
	defaultDocumentIDRandomBytes = 16
	documentIDTimestampBytes     = 6
)

const (
	defaultRerankTimeout   = 30 * time.Second
	minRerankTimeout       = time.Millisecond
	maxRerankTimeout       = 2_147_483_647 * time.Millisecond
	defaultMaxRerankWindow = 100
	minRerankWindow        = 1
	maxRerankWindow        = 1000
)

const (
	defaultMaxReopenWaiters = 64
	maxReopenFailures       = 5
	reopenBackoffBase       = 100 * time.Millisecond
	minSweepInterval        = 100 * time.Millisecond
	maxSweepInterval        = 60 * time.Second
)

const (
	syncEpochBytes             = 16
	defaultSyncHistoryMaxAgeMs = 2_592_000_000
	syncHistorySweepInterval   = time.Hour
	maxSyncPublishAttempts     = 3
)

const (
	maxRebalanceQueueEntries      = 10_000
	rebuildChunkDocuments         = 1000
	rebuildSwitchBacklogDocuments = 1000
)

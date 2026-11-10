package vector

import "time"

const (
	DefaultPromotionThreshold = 1024
	DefaultFilterThreshold    = 0.03
	DefaultM                  = 16
	MinM                      = 2
	MaxM                      = 512
	DefaultEfConstruction     = 200
	MaxVectorOrdinals         = 16_777_216
	MaxVectorDimension        = 65_535
	MaxSearchCandidates       = MaxVectorOrdinals

	minOversample            = 1
	oversampledDepthFloor    = 10_000
	scanChunkOrdinals        = 256
	searchScratchKeptEntries = 65_536

	defaultEfSearch             = 50
	maxLayerCap                 = 32
	osq4MinDimension            = 384
	vectorStoreInitialCapacity  = 16
	vectorBlockInitialSlots     = 256
	initialUpperSlots           = 64
	placementRoomRequests       = 8
	wasmPageBytes               = 65536
	maxWasmPages                = 65536
	blockMaxBytes               = wasmPageBytes * maxWasmPages
	diskStorageBlockBytes       = 67_108_864
	vectorScratchSlots          = 64
	scratchAlignmentBytes       = 16
	maxDocIDTableBytes          = 1_073_741_824
	unplacedFlagChunkOrdinals   = 1024
	ordinalChunkOrdinals        = 4096
	compactionTombstoneRatio    = 0.1
	compactionAbsoluteThreshold = 1000
	rebuildRemovedRatio         = 0.2
	driftCheckGrowthFactor      = 2
	recalibrationDriftRatio     = 2.5
	recalibrationChunkVectors   = 512
	MaxSearchThreadSlots        = 65_536
	maxWriterThreadSlots        = 4_096
	threadSlotCommitChunk       = 512
	loadedWriteSequence         = 1

	estimatedCompactPerTombstone   = 0.05
	estimatedOptimizePerVector     = 0.15
	dimensionScaleUnit             = 256
	buildRetryFirstDelay           = 250 * time.Millisecond
	buildRetryMaxDelay             = 30 * time.Second
	shuffledRebuildMemoryRetry     = time.Second
	vectorFileReplacedAboveDead    = 0.2
	vectorFileFixedOverheadBytes   = 65_536
	vectorFileStringHeaderBytes    = 5
	vectorFileCentroidBytesPerDim  = 9
	vectorGraphPartVectors         = 16_384
	vectorFileMaxVectors           = 65_536
	diskAdoptionYieldInterval      = 4096
	searchScratchInitialCandidates = 256
	initialReachQueue              = 4096
	liveCountsKept                 = 16
	growthPassMaxVectors           = 4096
)

const (
	narrowDimensionLimit                       = 768
	wideDimensionLimit                         = 1024
	efSearchMarginNarrow                       = 50
	efSearchMarginMiddle                       = 75
	efSearchMarginWide                         = 0
	osq2MiddleRescoreDepthPerSquareRootOfLimit = 18
)

const (
	coldGraphPartVectors     = vectorGraphPartVectors
	coldIDOffsetEntryBytes   = 4
	coldVectorComponentBytes = 4
	coldPageCacheSlots       = 64
	coldPartitionEntryBytes  = 4
	coldMagnitudeBytes       = 8
	coldPageChecksumBytes    = 4
)

package paged

const (
	ChecksumReadChunkBytes  = 4_194_304
	MaxStableHeadAttempts   = 8
	InitialBlockStarts      = 4_096
	SharedReadCacheBytes    = 134_217_728
	MergeReadCacheBytes     = 33_554_432
	LargestCachedEntryShare = 0.25
)

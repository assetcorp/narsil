package segment

const (
	DefaultTargetSegmentBytes = 1_073_741_824

	estimatedBytesPerToken    = 10
	estimatedBytesPerDocument = 64
	targetBlockEntries        = 128
	absentFieldLengthBound    = 0

	sectionWriteBufferBytes       = 1_048_576
	removalBucketWriteBufferBytes = 262_144
	removalBucketTargetBytes      = 67_108_864
	largestRemovalBucketCount     = 256
	fileAssemblyChunkBytes        = 4_194_304
	pagedWriterCancelCheckTokens  = 4_096
)

package codec

const (
	DefaultMaxEncodeDepth      = 100
	MaxDocumentEncodingDepth   = 100
	DocumentReplyEnvelopeDepth = 4
	DefaultMaxDecodeDepth      = 1000
	MaxExportNestingDepth      = 32
	gunzipReadChunkBytes       = 64 * 1024
	decodePreallocatedEntries  = 256
)

package schema

const (
	MaxNestingDepth          = 4
	MaxDocumentNestingDepth  = 32
	DefaultPatternValueLimit = 8_192
	MinPatternValueLimit     = 1
	MaxPatternValueLimit     = 65_536
	MaxVectorDimension       = 4_096
	MaxStoredVectorDimension = 65_535
	MaxTextFields            = 65_536
	MaxDocumentBytes         = 16_777_216
	MaxDocumentEncodingDepth = 100
	MaxDocIDLength           = 512
	MaxDocumentNodes         = MaxDocumentBytes
	MinHNSWNeighbours        = 2
	MaxHNSWNeighbours        = 512
	MaxLatitudeDegrees       = 90
	MaxLongitudeDegrees      = 180
	MaxJavaScriptDateMs      = 8_640_000_000_000_000
	MaxSafeInteger           = 9_007_199_254_740_991
	DefaultMaxPartitions     = 1
	MaxPartitions            = 65_536
)

package cursor

const (
	ResultWindow              = 10_000
	DefaultLimit              = 10
	maxSortFields             = 8
	maxSortFieldNameLength    = 255
	maxCursorLength           = 40_960
	maxCursorAnchorCodePoints = 512
	shownCursorUnits          = 100
	shownSortFieldNameUnits   = 64
	initialCursorPayloadBytes = 128
	initialSortSignatureBytes = 64
)

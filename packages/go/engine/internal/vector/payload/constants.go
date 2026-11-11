package payload

const (
	VectorFilePayloadVersion      = 1
	VectorGraphPayloadVersion     = 1
	VectorGraphPartPayloadVersion = 2
	VectorFileEnvelopeVersion     = 2
	GraphPartEnvelopeVersion      = 2
	GraphPartVectors              = 16_384
	VectorFileMaxVectors          = 65_536
	MaxDimension                  = 65_535
	MinM                          = 2
	MaxM                          = 512
	MaxLayerCap                   = 32

	SegmentPageBytes   = 65_536
	RecordPageBytes    = 16_384
	stableHeadAttempts = 8
	recordTrailerBytes = 16
	float32Bytes       = 4
	float64Bytes       = 8
	uint32Bytes        = 4
	bitsPerByte        = 8
	pageChecksumBytes  = 4
)

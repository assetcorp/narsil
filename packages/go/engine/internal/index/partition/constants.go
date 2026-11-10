package partition

import "time"

const (
	ArrayPositionGap         = 100
	FreezeAtGrowingBytes     = 16 << 20
	SideReaderWaitFirstDelay = 2 * time.Microsecond
	SideReaderWaitMaxDelay   = time.Millisecond
)

const documentTableFirstChunkBits = 4

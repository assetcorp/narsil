package partition

import "time"

const (
	ArrayPositionGap            = 100
	FreezeAtGrowingBytes        = 16 << 20
	SideCopyAtPendingOperations = 512
	SideReaderWaitFirstDelay    = 2 * time.Microsecond
	SideReaderWaitMaxDelay      = time.Millisecond
	TokenRoundsPerWrite         = 3
)

const documentTableFirstChunkBits = 4

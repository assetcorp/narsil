package storage

import "time"

const (
	directoryMode = 0o755
	fileMode      = 0o644

	LockFileName              = ".narsil.lock"
	lockAttempts              = 3
	lockSettleDelay           = 50 * time.Millisecond
	lockProcessStartTolerance = time.Second
	lockTokenBytes            = 16
	directoryHeldOpenOnlyOn   = "linux"

	temporaryNameRandomBytes = 8
	streamWriteBufferBytes   = 1_048_576
)

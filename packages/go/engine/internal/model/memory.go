package model

type ProcessMemoryReport struct {
	HeapUsed  int64
	HeapTotal int64
	HeapLimit Optional[int64]
	External  int64
	RSS       int64
}

type WorkerCopyReport struct {
	IndexName   string
	ScaledOut   bool
	ReloadCount int
}

type HeldCheckpointReport struct {
	IndexName                    string
	PartitionIDs                 []int
	RecordsSinceCheckpoint       int64
	DocumentBytesSinceCheckpoint int64
}

type WorkerMemoryReport struct {
	WorkerID  int
	HeapUsed  int64
	HeapTotal int64
	HeapLimit Optional[int64]
	External  int64
}

type MemoryStats struct {
	Process             *ProcessMemoryReport
	EstimatedIndexBytes int64
	OpenIndexCount      int
	ClosedIndexCount    int
	ReopenCount         int
	WorkerCopies        []WorkerCopyReport
	HeldCheckpoints     []HeldCheckpointReport
	Workers             []WorkerMemoryReport
}

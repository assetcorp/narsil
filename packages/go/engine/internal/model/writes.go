package model

import "time"

type WriteOptions struct {
	Wait bool
}

type InsertOptions struct {
	WriteOptions
	SkipClone bool
}

type DocumentUpdate struct {
	DocID    string
	Document *Document
}

type SnapshotOptions struct {
	QueryHistory bool
}

type SyncSetting struct {
	Enabled         bool
	HistoryMaxAge   Optional[time.Duration]
	HistoryMaxBytes Optional[int64]
}

type SyncStatus struct {
	SyncSetting
	Active bool
	Epoch  string
}

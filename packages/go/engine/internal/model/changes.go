package model

import "time"

type ChangesSetting struct {
	Enabled          bool
	PreviousDocument bool
	HistoryMaxAge    Optional[time.Duration]
	HistoryMaxBytes  Optional[int64]
}

type ChangesStatus struct {
	ChangesSetting
	Epoch string
}

type ChangePosition struct {
	PartitionID uint32
	SeqNo       uint64
}

type ChangesRequest struct {
	Epoch     Optional[string]
	Positions []ChangePosition
	Filter    *FilterExpression
}

type ChangeType string

const (
	ChangePut    ChangeType = "put"
	ChangeInsert ChangeType = "insert"
	ChangeUpdate ChangeType = "update"
	ChangeRemove ChangeType = "remove"
)

type Change struct {
	SeqNo            uint64
	Type             ChangeType
	DocumentID       string
	Document         *Document
	PreviousDocument *Document
}

type ChangesSubscribed struct {
	Epoch            string
	PartitionCount   uint32
	Positions        []ChangePosition
	Heads            []ChangePosition
	BytesBehind      uint64
	PreviousDocument bool
}

type ChangeGroup struct {
	PartitionID  uint32
	Changes      []Change
	ScannedSeqNo uint64
}

type ResyncReason string

const (
	ResyncEpoch   ResyncReason = "epoch"
	ResyncHistory ResyncReason = "history"
	ResyncAhead   ResyncReason = "ahead"
)

type ChangesResync struct {
	Reason ResyncReason
}

type ChangesEvent struct {
	Subscribed *ChangesSubscribed
	Group      *ChangeGroup
	Resync     *ChangesResync
}

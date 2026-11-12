package engine_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

func firstOutcome(t *testing.T, narsil *engine.Narsil, request engine.ChangesRequest) (engine.ChangesEvent, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), changesEventWait)
	defer cancel()
	for event, err := range narsil.Changes(ctx, changesIndex, request) {
		return event, err
	}
	t.Fatal("the changes iteration ended without an event")
	return engine.ChangesEvent{}, nil
}

func positionsOf(seqNos ...uint64) []engine.ChangePosition {
	positions := make([]engine.ChangePosition, len(seqNos))
	for partitionID, seqNo := range seqNos {
		positions[partitionID] = engine.ChangePosition{PartitionID: uint32(partitionID), SeqNo: seqNo}
	}
	return positions
}

func nestedFilter(depth int) *engine.FilterExpression {
	expression := &engine.FilterExpression{Fields: map[string]engine.FieldFilter{"status": {Eq: engine.TextValue("open")}}}
	for range depth {
		expression = &engine.FilterExpression{Not: expression}
	}
	return expression
}

func TestChangesRefuseMalformedRequestsWithTheirCodes(t *testing.T) {
	narsil := openChangesEngine(t, t.TempDir(), 0)
	defer func() { _ = narsil.Shutdown(context.Background()) }()
	createChangesIndex(t, narsil, 2, engine.ChangesSetting{Enabled: true, PreviousDocument: true})
	oracle := newWriteOracle()
	oracle.insert(t, narsil, "a", ticket("a", 0, "open"))
	status, err := narsil.GetChanges(context.Background(), changesIndex)
	if err != nil {
		t.Fatalf("reading the setting failed with %s: %v", codeOrMessage(err), err)
	}
	epoch := engine.Some(status.Epoch)
	openFilter := &engine.FilterExpression{Fields: map[string]engine.FieldFilter{"status": {Eq: engine.TextValue("open")}}}
	refusals := map[string]struct {
		request engine.ChangesRequest
		code    string
	}{
		"epoch without positions": {engine.ChangesRequest{Epoch: epoch}, engine.CodeChangesInvalidPositions},
		"positions without epoch": {engine.ChangesRequest{Positions: positionsOf(0, 0)}, engine.CodeChangesInvalidPositions},
		"uppercase epoch": {engine.ChangesRequest{Epoch: engine.Some(strings.ToUpper(status.Epoch)),
			Positions: positionsOf(0, 0)}, engine.CodeChangesInvalidPositions},
		"short epoch": {engine.ChangesRequest{Epoch: engine.Some(status.Epoch[1:]), Positions: positionsOf(0, 0)},
			engine.CodeChangesInvalidPositions},
		"empty epoch":       {engine.ChangesRequest{Epoch: engine.Some(""), Positions: positionsOf(0, 0)}, engine.CodeChangesInvalidPositions},
		"missing partition": {engine.ChangesRequest{Epoch: epoch, Positions: positionsOf(0)}, engine.CodeChangesInvalidPositions},
		"repeated partition": {engine.ChangesRequest{Epoch: epoch, Positions: []engine.ChangePosition{{PartitionID: 0},
			{PartitionID: 0}}}, engine.CodeChangesInvalidPositions},
		"unknown partition": {engine.ChangesRequest{Epoch: epoch, Positions: []engine.ChangePosition{{PartitionID: 0},
			{PartitionID: 4_294_967_295}}}, engine.CodeChangesInvalidPositions},
		"extra partition": {engine.ChangesRequest{Epoch: epoch, Positions: positionsOf(0, 0, 0)},
			engine.CodeChangesInvalidPositions},
		"unknown filter field": {engine.ChangesRequest{Filter: &engine.FilterExpression{
			Fields: map[string]engine.FieldFilter{"owner": {Eq: engine.TextValue("x")}}}}, engine.CodeSearchInvalidField},
		"range on an enum": {engine.ChangesRequest{Filter: &engine.FilterExpression{
			Fields: map[string]engine.FieldFilter{"status": {Gt: engine.NumberBound(1)}}}}, engine.CodeSearchInvalidFilter},
		"filter too deep": {engine.ChangesRequest{Filter: nestedFilter(64)}, engine.CodeSearchInvalidFilter},
	}
	for name, refusal := range refusals {
		t.Run(name, func(t *testing.T) {
			event, err := firstOutcome(t, narsil, refusal.request)
			if engine.ErrorCode(err) != refusal.code {
				t.Fatalf("the request gave %+v with %s, while it needed %s", event, codeOrMessage(err), refusal.code)
			}
		})
	}
	resyncs := map[string]struct {
		request engine.ChangesRequest
		reason  engine.ResyncReason
	}{
		"another epoch": {engine.ChangesRequest{Epoch: engine.Some(strings.Repeat("0", 32)), Positions: positionsOf(0)},
			engine.ResyncEpoch},
		"position ahead": {engine.ChangesRequest{Epoch: epoch, Positions: positionsOf(1_000_000, 1_000_000)},
			engine.ResyncAhead},
		"largest position": {engine.ChangesRequest{Epoch: epoch, Positions: positionsOf(^uint64(0), ^uint64(0))},
			engine.ResyncAhead},
	}
	for name, resync := range resyncs {
		t.Run(name, func(t *testing.T) {
			event, err := firstOutcome(t, narsil, resync.request)
			if err != nil || event.Resync == nil || event.Resync.Reason != resync.reason {
				t.Fatalf("the request gave %+v with %s, while it needed a resync for %q", event, codeOrMessage(err),
					resync.reason)
			}
		})
	}
	t.Run("filter while previous document is off", func(t *testing.T) {
		if err := narsil.UpdateChanges(context.Background(), changesIndex, engine.ChangesSetting{Enabled: true}); err != nil {
			t.Fatalf("turning previousDocument off failed with %s: %v", codeOrMessage(err), err)
		}
		_, err := firstOutcome(t, narsil, engine.ChangesRequest{Filter: openFilter})
		if engine.ErrorCode(err) != engine.CodeChangesPreviousDocumentRequired {
			t.Fatalf("a filter on an index without previous documents failed with %s", codeOrMessage(err))
		}
	})
	t.Run("missing index", func(t *testing.T) {
		ctx := context.Background()
		for _, err := range narsil.Changes(ctx, "nowhere", engine.ChangesRequest{}) {
			if engine.ErrorCode(err) != engine.CodeIndexNotFound {
				t.Fatalf("a request for a missing index failed with %s", codeOrMessage(err))
			}
		}
	})
	t.Run("cancelled context", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		for event, err := range narsil.Changes(ctx, changesIndex, engine.ChangesRequest{}) {
			if err == nil {
				t.Fatalf("a request under a cancelled context gave %+v", event)
			}
		}
	})
}

func TestChangesSettingRefusesBadLimitsAndEnginesWithoutTheLog(t *testing.T) {
	narsil := openChangesEngine(t, t.TempDir(), 0)
	defer func() { _ = narsil.Shutdown(context.Background()) }()
	ctx := context.Background()
	createChangesIndex(t, narsil, 1, engine.ChangesSetting{Enabled: false})
	bad := map[string]engine.ChangesSetting{
		"zero age":         {Enabled: true, HistoryMaxAge: engine.Some(time.Duration(0))},
		"negative age":     {Enabled: true, HistoryMaxAge: engine.Some(-time.Hour)},
		"fractional age":   {Enabled: true, HistoryMaxAge: engine.Some(time.Millisecond + time.Microsecond)},
		"zero bytes":       {Enabled: true, HistoryMaxBytes: engine.Some(int64(0))},
		"negative bytes":   {Enabled: true, HistoryMaxBytes: engine.Some(int64(-1))},
		"bytes past limit": {Enabled: true, HistoryMaxBytes: engine.Some(int64(1) << 62)},
	}
	for name, setting := range bad {
		t.Run(name, func(t *testing.T) {
			if err := narsil.UpdateChanges(ctx, changesIndex, setting); engine.ErrorCode(err) != engine.CodeConfigInvalid {
				t.Fatalf("the setting was answered with %s", codeOrMessage(err))
			}
			status, err := narsil.GetChanges(ctx, changesIndex)
			if err != nil || status.Enabled {
				t.Fatalf("a refused setting left capture at %+v with error %s", status, codeOrMessage(err))
			}
		})
	}
	if err := narsil.UpdateChanges(ctx, "nowhere", engine.ChangesSetting{Enabled: true}); engine.ErrorCode(err) !=
		engine.CodeIndexNotFound {
		t.Fatalf("a setting for a missing index failed with %s", codeOrMessage(err))
	}
	memory, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)}})
	if err != nil {
		t.Fatalf("the engine refused to start with %s: %v", codeOrMessage(err), err)
	}
	defer func() { _ = memory.Shutdown(context.Background()) }()
	if err := memory.CreateIndex(ctx, changesIndex, engine.IndexConfig{Schema: ticketSchema()}); err != nil {
		t.Fatalf("the engine refused the index with %s: %v", codeOrMessage(err), err)
	}
	if err := memory.UpdateChanges(ctx, changesIndex, engine.ChangesSetting{Enabled: true}); engine.ErrorCode(err) !=
		engine.CodeChangesDurabilityRequired {
		t.Fatalf("change capture on an engine without the log was answered with %s", codeOrMessage(err))
	}
	if _, err := firstOutcome(t, memory, engine.ChangesRequest{}); engine.ErrorCode(err) != engine.CodeChangesNotEnabled {
		t.Fatalf("a request for changes on an engine without the log failed with %s", codeOrMessage(err))
	}
}

package engine_test

import (
	"context"
	"reflect"
	"strconv"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

func openTicketsFilter() *engine.FilterExpression {
	return &engine.FilterExpression{Fields: map[string]engine.FieldFilter{"status": {Eq: engine.TextValue("open")}}}
}

func isOpenTicket(document map[string]any) bool {
	return document != nil && document["status"] == "open"
}

func expectedFilteredChange(before, after map[string]any) (engine.ChangeType, map[string]any, map[string]any, bool) {
	beforeMatches, afterMatches := isOpenTicket(before), isOpenTicket(after)
	switch {
	case beforeMatches && afterMatches:
		return engine.ChangeUpdate, after, before, true
	case afterMatches:
		return engine.ChangeInsert, after, nil, true
	case beforeMatches:
		return engine.ChangeRemove, nil, before, true
	}
	return "", nil, nil, false
}

func openTickets(documents map[string]map[string]any) map[string]map[string]any {
	kept := map[string]map[string]any{}
	for id, document := range documents {
		if isOpenTicket(document) {
			kept[id] = document
		}
	}
	return kept
}

func scannedTotal(positions []uint64) uint64 {
	var total uint64
	for _, seqNo := range positions {
		total += seqNo
	}
	return total
}

func TestFilteredChangesFollowDocumentsAsTheyEnterAndLeaveTheFilter(t *testing.T) {
	narsil := openChangesEngine(t, t.TempDir(), 0)
	defer func() { _ = narsil.Shutdown(context.Background()) }()
	createChangesIndex(t, narsil, 2, engine.ChangesSetting{Enabled: true, PreviousDocument: true})
	tap := tapChanges(t, narsil, engine.ChangesRequest{Filter: openTicketsFilter()})
	reader := newSubscriber(tap.subscribed(t))
	oracle := newWriteOracle()
	for round := range 6 {
		for slot := range 12 {
			id := "f" + strconv.Itoa(slot)
			status := []string{"open", "closed"}[(slot*round+slot/3)%2]
			_, held := oracle.snapshot()[id]
			switch {
			case !held:
				oracle.insert(t, narsil, id, ticket(id, round, status))
			case (slot+round)%5 == 0:
				oracle.remove(t, narsil, id)
			default:
				oracle.update(t, narsil, id, ticket(id, round, status))
			}
		}
	}
	expected := map[string][]transition{}
	writes := 0
	for id, queue := range oracle.transitions {
		writes += len(queue)
		for _, step := range queue {
			if _, after, before, sent := expectedFilteredChange(step.before, step.after); sent {
				expected[id] = append(expected[id], transition{before: before, after: after})
			}
		}
	}
	got := map[string][]transition{}
	for scannedTotal(reader.positions) < uint64(writes) {
		received := tap.next(t)
		if received.err != nil || received.event.Group == nil {
			t.Fatalf("the filtered iteration sent %+v with error %s", received.event, codeOrMessage(received.err))
		}
		for _, change := range received.event.Group.Changes {
			before, after := mapOf(change.PreviousDocument), mapOf(change.Document)
			wantType, _, _, _ := expectedFilteredChange(before, after)
			if change.Type != wantType && !(change.Type == engine.ChangeRemove && before != nil && after == nil) {
				t.Fatalf("change %d of %s has type %q for before %v and after %v", change.SeqNo, change.DocumentID,
					change.Type, before, after)
			}
			got[change.DocumentID] = append(got[change.DocumentID], transition{before: before, after: after})
		}
		reader.apply(t, received.event.Group, nil)
	}
	if !reflect.DeepEqual(got, expected) {
		t.Fatalf("the filtered changes were %v, while the filter table gives %v", got, expected)
	}
	reader.requireMatches(t, openTickets(oracle.snapshot()))
}

func TestFilteredChangesAdvanceThePositionWhenNothingMatches(t *testing.T) {
	narsil := openChangesEngine(t, t.TempDir(), 0)
	defer func() { _ = narsil.Shutdown(context.Background()) }()
	createChangesIndex(t, narsil, 2, engine.ChangesSetting{Enabled: true, PreviousDocument: true})
	tap := tapChanges(t, narsil, engine.ChangesRequest{Filter: openTicketsFilter()})
	reader := newSubscriber(tap.subscribed(t))
	oracle := newWriteOracle()
	const closedTickets = 3000
	for slot := range closedTickets {
		id := "c" + strconv.Itoa(slot)
		oracle.insert(t, narsil, id, ticket(id, 0, "closed"))
	}
	groups := 0
	for scannedTotal(reader.positions) < closedTickets {
		received := tap.next(t)
		if received.err != nil || received.event.Group == nil {
			t.Fatalf("the filtered iteration sent %+v with error %s", received.event, codeOrMessage(received.err))
		}
		if len(received.event.Group.Changes) != 0 {
			t.Fatalf("a filter that matches no document sent %d changes", len(received.event.Group.Changes))
		}
		reader.apply(t, received.event.Group, nil)
		groups++
	}
	if groups < 2 {
		t.Fatalf("the iteration covered %d entries in %d groups", closedTickets, groups)
	}
	tap.quiet(t)
}

func TestFilteredChangesOfEntriesWithoutThePreviousDocumentSendPutOrBareRemoval(t *testing.T) {
	narsil := openChangesEngine(t, t.TempDir(), 0)
	defer func() { _ = narsil.Shutdown(context.Background()) }()
	ctx := context.Background()
	createChangesIndex(t, narsil, 1, engine.ChangesSetting{Enabled: true})
	start := tapChanges(t, narsil, engine.ChangesRequest{})
	reader := newSubscriber(start.subscribed(t))
	start.stop()
	oracle := newWriteOracle()
	oracle.insert(t, narsil, "open", ticket("open", 0, "open"))
	oracle.insert(t, narsil, "closed", ticket("closed", 0, "closed"))
	oracle.remove(t, narsil, "open")
	if err := narsil.UpdateChanges(ctx, changesIndex, engine.ChangesSetting{Enabled: true, PreviousDocument: true}); err != nil {
		t.Fatalf("turning previousDocument on failed with %s: %v", codeOrMessage(err), err)
	}
	request := reader.request()
	request.Filter = openTicketsFilter()
	tap := tapChanges(t, narsil, request)
	tap.subscribed(t)
	types := map[string][]engine.ChangeType{}
	for scannedTotal(reader.positions) < 3 {
		received := tap.next(t)
		if received.err != nil || received.event.Group == nil {
			t.Fatalf("the filtered iteration sent %+v with error %s", received.event, codeOrMessage(received.err))
		}
		for _, change := range received.event.Group.Changes {
			if change.PreviousDocument != nil {
				t.Fatalf("change %d holds a previous document that its entry lacks", change.SeqNo)
			}
			types[change.DocumentID] = append(types[change.DocumentID], change.Type)
		}
		reader.apply(t, received.event.Group, nil)
	}
	want := map[string][]engine.ChangeType{"open": {engine.ChangePut, engine.ChangeRemove},
		"closed": {engine.ChangeRemove}}
	if !reflect.DeepEqual(types, want) {
		t.Fatalf("the filtered changes were %v, while entries without the previous document give %v", types, want)
	}
}

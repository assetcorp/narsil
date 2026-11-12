package changes_test

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"testing"

	narsil "github.com/assetcorp/narsil/packages/go"
	"github.com/assetcorp/narsil/packages/go/changes"
)

const exportLineBytes = 16 << 20

type documentExport struct {
	epoch     string
	positions []changes.Position
	documents map[string]string
}

func fieldsOf(t *testing.T, document map[string]any) string {
	t.Helper()
	encoded, err := json.Marshal(map[string]any{
		"title": document["title"], "price": document["price"], "embedding": document["embedding"],
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func exportOf(t *testing.T, ctx context.Context, admin *narsil.Client) documentExport {
	t.Helper()
	stream, err := admin.ExportDocuments(ctx, testIndex)
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	scanner := bufio.NewScanner(stream)
	scanner.Buffer(make([]byte, 0, 64<<10), exportLineBytes)
	if !scanner.Scan() {
		t.Fatalf("the export holds no header: %v", scanner.Err())
	}
	var header struct {
		Epoch     string `json:"epoch"`
		Positions []struct {
			PartitionID uint32 `json:"partitionId"`
			SeqNo       uint64 `json:"seqNo"`
		} `json:"positions"`
	}
	if err := json.Unmarshal(scanner.Bytes(), &header); err != nil {
		t.Fatal(err)
	}
	copied := documentExport{epoch: header.Epoch, documents: map[string]string{}}
	for _, position := range header.Positions {
		copied.positions = append(copied.positions, changes.Position{PartitionID: position.PartitionID, SeqNo: position.SeqNo})
	}
	for scanner.Scan() {
		var line map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &line); err != nil {
			t.Fatal(err)
		}
		id, _ := line["id"].(string)
		copied.documents[id] = fieldsOf(t, line)
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	return copied
}

func caughtUp(heads []changes.Position, saved map[uint32]uint64) bool {
	for _, head := range heads {
		if position, ok := saved[head.PartitionID]; !ok || position < head.SeqNo {
			return false
		}
	}
	return true
}

func TestFollowingFromAnExportRebuildsTheIndexExactly(t *testing.T) {
	ctx := testContext(t)
	server := startServer(t, serverSettings{})
	admin := newClient(t, server, adminCredential)
	shopWithCapture(t, ctx, admin, true)

	expected := map[string]string{}
	for at := range 30 {
		id := fmt.Sprintf("p%d", at)
		insert(t, ctx, admin, id, product(at))
		expected[id] = fieldsOf(t, product(at))
	}
	copied := exportOf(t, ctx, admin)
	if len(copied.positions) != partitionCount {
		t.Fatalf("the export header holds %d positions for %d partitions", len(copied.positions), partitionCount)
	}
	updatedFrom := map[string]string{}
	floatVectors := map[string]bool{}
	for at := 0; at < 30; at += 3 {
		id := fmt.Sprintf("p%d", at)
		updatedFrom[id] = expected[id]
		if _, err := admin.Update(ctx, testIndex, id, narsil.DocumentBody{Document: product(at + 1000)}); err != nil {
			t.Fatal(err)
		}
		expected[id] = fieldsOf(t, product(at+1000))
	}
	for at := 1; at < 30; at += 5 {
		id := fmt.Sprintf("p%d", at)
		if _, err := admin.Remove(ctx, testIndex, id, narsil.RemoveParams{}); err != nil {
			t.Fatal(err)
		}
		delete(expected, id)
	}
	for at := 30; at < 40; at++ {
		id := fmt.Sprintf("p%d", at)
		server.insertThroughEngine(t, id, product(at))
		expected[id] = fieldsOf(t, product(at))
		floatVectors[id] = true
	}
	if _, err := admin.Checkpoint(ctx, testIndex); err != nil {
		t.Fatal(err)
	}

	reader := newClient(t, server, "")
	subscription := follow(t, ctx, reader, changes.Options{
		Epoch: copied.epoch, Positions: copied.positions, Credential: readerCredential,
	})
	var heads []changes.Position
	saved := map[uint32]uint64{}
	previousSeen := map[string]string{}
	for event, err := range subscription.All() {
		if err != nil {
			t.Fatal(err)
		}
		switch typed := event.(type) {
		case *changes.Subscribed:
			if typed.Epoch != copied.epoch || !typed.PreviousDocument || typed.PartitionCount != partitionCount {
				t.Fatalf("the feed subscribed under %+v", typed)
			}
			heads = typed.Heads
			for _, position := range typed.Positions {
				saved[position.PartitionID] = position.SeqNo
			}
		case *changes.Batch:
			for _, change := range typed.Changes {
				if change.Type == changes.ChangeRemove {
					delete(copied.documents, change.DocumentID)
					continue
				}
				if _, isFloat32 := change.Document["embedding"].([]float32); isFloat32 != floatVectors[change.DocumentID] {
					t.Fatalf("the change of %s holds the embedding %#v", change.DocumentID, change.Document["embedding"])
				}
				copied.documents[change.DocumentID] = fieldsOf(t, change.Document)
				if change.Type == changes.ChangeUpdate {
					previousSeen[change.DocumentID] = fieldsOf(t, change.PreviousDocument)
				}
			}
			saved[typed.PartitionID] = typed.ScannedSeqNo
			if err := subscription.Ack([]changes.Position{{PartitionID: typed.PartitionID, SeqNo: typed.ScannedSeqNo}}); err != nil {
				t.Fatal(err)
			}
		case *changes.Resync:
			t.Fatalf("the feed asked for a resync: %s", typed.Reason)
		}
		if heads != nil && caughtUp(heads, saved) {
			break
		}
	}

	ids := map[string]bool{}
	for id := range copied.documents {
		ids[id] = true
	}
	for id := range expected {
		ids[id] = true
	}
	for _, id := range slices.Sorted(maps.Keys(ids)) {
		if copied.documents[id] != expected[id] {
			t.Fatalf("the rebuilt copy holds %s as %q, and the acknowledged writes give %q", id, copied.documents[id], expected[id])
		}
	}
	if !maps.Equal(previousSeen, updatedFrom) {
		t.Fatalf("the updates carried previous documents %v, and the writes replaced %v", previousSeen, updatedFrom)
	}
}

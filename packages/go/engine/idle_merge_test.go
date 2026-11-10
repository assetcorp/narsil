package engine_test

import (
	"context"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	idleMergeIndex         = "articles"
	idleMergeDocuments     = 4_500
	idleMergeBatch         = 500
	idleMergeCodeUnits     = 4_000
	idleMergeQuietPeriod   = 1_500 * time.Millisecond
	idleMergeMarkerEvery   = 7
	idleMergeMarkerWord    = "lighthouse"
	growingSegmentFreezeAt = 16 << 20
)

func idleMergeDocument(serial int, filler string) map[string]any {
	body := "harbour report " + strconv.Itoa(serial)
	if serial%idleMergeMarkerEvery == 0 {
		body += " " + idleMergeMarkerWord
	}
	return map[string]any{"body": body, "code": strconv.Itoa(serial) + filler}
}

func TestAQuietIndexMergesItsFrozenTextAndItsTailIntoOneSegment(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)}})
	if err != nil {
		t.Fatalf("starting the engine failed: %v", err)
	}
	defer func() { _ = narsil.Shutdown(ctx) }()
	if err := narsil.CreateIndex(ctx, idleMergeIndex, engine.IndexConfig{Schema: engine.Schema{"body": engine.FieldString,
		"code": engine.FieldEnum}, Language: "english"}); err != nil {
		t.Fatalf("creating the index failed: %v", err)
	}
	filler := strings.Repeat("x", idleMergeCodeUnits)
	marked := 0
	for first := 0; first < idleMergeDocuments; first += idleMergeBatch {
		documents := make([]*engine.Document, 0, idleMergeBatch)
		for serial := first; serial < first+idleMergeBatch; serial++ {
			if serial%idleMergeMarkerEvery == 0 {
				marked++
			}
			documents = append(documents, engine.DocumentFromMap(idleMergeDocument(serial, filler)))
		}
		result, err := narsil.InsertBatch(ctx, idleMergeIndex, documents, engine.InsertOptions{})
		if err != nil || len(result.Failed) > 0 {
			t.Fatalf("inserting from document %d failed: %v %+v", first, err, result.Failed)
		}
	}
	if codeBytes := idleMergeDocuments * idleMergeCodeUnits; codeBytes <= growingSegmentFreezeAt {
		t.Fatalf("the ingest holds %d bytes of codes, short of the %d bytes at which a growing segment freezes",
			codeBytes, growingSegmentFreezeAt)
	}
	time.Sleep(idleMergeQuietPeriod)
	segments, err := engine.SearchedSegmentsOf(ctx, narsil, idleMergeIndex)
	if err != nil {
		t.Fatalf("reading the searched segments failed: %v", err)
	}
	if len(segments) != 1 || segments[0] != 1 {
		t.Fatalf("after a quiet period, a search reads %v segments per partition, while an idle index merges its text into one",
			segments)
	}
	found, err := narsil.Query(ctx, idleMergeIndex, engine.QueryParams{Term: idleMergeMarkerWord,
		Limit: engine.Some(idleMergeDocuments / idleMergeMarkerEvery * 2)})
	if err != nil {
		t.Fatalf("searching the merged index failed: %v", err)
	}
	if found.Count != marked || len(found.Hits) != marked {
		t.Fatalf("the merged index found %d documents (%d hits) holding %q, while %d hold it",
			found.Count, len(found.Hits), idleMergeMarkerWord, marked)
	}
}

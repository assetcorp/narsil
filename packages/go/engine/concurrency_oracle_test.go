package engine_test

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strconv"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	mixedIndexName       = "shelves"
	mixedSlotsPerOwner   = 260
	mixedVectorDimension = 4
	mixedScoreTolerance  = 1e-5
	mixedHitCeiling      = 2_000
	mixedNearestChecked  = 5
)

var mixedOwnerTokens = []string{"quokka", "marmot", "okapi", "wombat", "tapir", "ibis"}

type mixedDocument struct {
	rank   float64
	vector []float32
}

type mixedOwner struct {
	mu    sync.Mutex
	token string
	live  map[string]mixedDocument
}

func mixedID(owner int, slot int) string {
	return "o" + strconv.Itoa(owner) + "-s" + strconv.Itoa(slot)
}

func mixedVector(slot int, version int) []float32 {
	angle := float64(slot)*0.61 + float64(version)*1.37
	return []float32{float32(math.Cos(angle)), float32(math.Sin(angle)), float32(version%5) / 5, float32(slot%3+1) / 3}
}

func mixedFields(token string, slot int, version int) (*engine.Document, mixedDocument) {
	held := mixedDocument{rank: float64(slot) + float64(version%997)/1000, vector: mixedVector(slot, version)}
	return engine.DocumentFromMap(map[string]any{
		"title":     token + " shelf " + strconv.Itoa(slot),
		"owner":     token,
		"rank":      held.rank,
		"embedding": held.vector,
	}), held
}

func mixedSchema() engine.IndexConfig {
	return engine.IndexConfig{Schema: engine.Schema{"title": engine.FieldString, "owner": engine.FieldEnum,
		"rank": engine.FieldNumber, "embedding": engine.VectorFieldType(mixedVectorDimension)}}
}

func ownerFilter(token string) *engine.FilterExpression {
	return &engine.FilterExpression{Fields: map[string]engine.FieldFilter{"owner": {Eq: engine.TextValue(token)}}}
}

func exactCosine(left []float32, right []float32) float64 {
	var dot, leftNorm, rightNorm float64
	for component := range left {
		dot += float64(left[component]) * float64(right[component])
		leftNorm += float64(left[component]) * float64(left[component])
		rightNorm += float64(right[component]) * float64(right[component])
	}
	return dot / math.Sqrt(leftNorm*rightNorm)
}

func checkOwnerAnswers(ctx context.Context, narsil *engine.Narsil, owner *mixedOwner, probe []float32) error {
	wantIDs := make([]string, 0, len(owner.live))
	for id := range owner.live {
		wantIDs = append(wantIDs, id)
	}
	sort.Slice(wantIDs, func(left, right int) bool { return owner.live[wantIDs[left]].rank < owner.live[wantIDs[right]].rank })
	keyword, err := narsil.Query(ctx, mixedIndexName, engine.QueryParams{Term: owner.token, Fields: []string{"title"},
		Limit: engine.Some(mixedHitCeiling), Document: engine.NoDocumentFields()})
	if err != nil {
		return fmt.Errorf("the keyword search for %s failed: %w", owner.token, err)
	}
	found := map[string]bool{}
	for _, hit := range keyword.Hits {
		if _, live := owner.live[hit.ID]; !live || found[hit.ID] {
			return fmt.Errorf("the keyword search for %s returned %s, which is not a live document of that owner or repeats", owner.token, hit.ID)
		}
		found[hit.ID] = true
	}
	if len(found) != len(owner.live) {
		return fmt.Errorf("the keyword search for %s returned %d documents, while %d are live", owner.token, len(found), len(owner.live))
	}
	byRank := []engine.SortField{{Field: "rank", Direction: engine.SortAscending}}
	sorted, err := narsil.Query(ctx, mixedIndexName, engine.QueryParams{Term: owner.token, Filters: ownerFilter(owner.token),
		Limit: engine.Some(mixedHitCeiling), Sort: byRank, Document: engine.NoDocumentFields()})
	if err != nil {
		return fmt.Errorf("the sorted filter for %s failed: %w", owner.token, err)
	}
	listed, err := narsil.ListDocuments(ctx, mixedIndexName, engine.ListParams{Filters: ownerFilter(owner.token),
		Limit: engine.Some(mixedHitCeiling), Sort: byRank, Document: engine.NoDocumentFields()})
	if err != nil {
		return fmt.Errorf("listing the documents of %s failed: %w", owner.token, err)
	}
	if len(sorted.Hits) != len(wantIDs) || len(listed.Documents) != len(wantIDs) {
		return fmt.Errorf("the sorted filter for %s returned %d documents and the listing %d, while %d are live", owner.token,
			len(sorted.Hits), len(listed.Documents), len(wantIDs))
	}
	for position, hit := range sorted.Hits {
		if hit.ID != wantIDs[position] || listed.Documents[position].ID != wantIDs[position] {
			return fmt.Errorf("the sorted filter for %s puts %s and the listing %s at %d, where the oracle puts %s", owner.token, hit.ID,
				listed.Documents[position].ID, position, wantIDs[position])
		}
	}
	nearest, err := narsil.Query(ctx, mixedIndexName, engine.QueryParams{Mode: engine.SearchVector, Filters: ownerFilter(owner.token),
		Limit: engine.Some(mixedNearestChecked), IncludeScores: true, Document: engine.NoDocumentFields(),
		Vector: &engine.VectorQueryConfig{Field: "embedding", Value: probe}})
	if err != nil {
		return fmt.Errorf("the vector search for %s failed: %w", owner.token, err)
	}
	if len(nearest.Hits) != min(mixedNearestChecked, len(owner.live)) {
		return fmt.Errorf("the vector search for %s returned %d hits over %d live documents", owner.token, len(nearest.Hits), len(owner.live))
	}
	for _, hit := range nearest.Hits {
		held, live := owner.live[hit.ID]
		score, scored := hit.Score.Get()
		if !live || !scored || math.Abs(score-exactCosine(probe, held.vector)) > mixedScoreTolerance {
			return fmt.Errorf("the vector search for %s returned %s with score %v, which disagrees with its live vector", owner.token, hit.ID, score)
		}
	}
	return nil
}

func checkEveryOwner(ctx context.Context, narsil *engine.Narsil, owners []*mixedOwner) error {
	total := 0
	for position, owner := range owners {
		if err := checkOwnerAnswers(ctx, narsil, owner, mixedVector(position, position)); err != nil {
			return err
		}
		total += len(owner.live)
	}
	count, err := narsil.CountDocuments(ctx, mixedIndexName)
	if err != nil {
		return err
	}
	if count != total {
		return fmt.Errorf("the index counts %d documents, while the oracle holds %d", count, total)
	}
	return nil
}

func copyOwnerStates(owners []*mixedOwner) []map[string]mixedDocument {
	copies := make([]map[string]mixedDocument, len(owners))
	for position, owner := range owners {
		copies[position] = make(map[string]mixedDocument, len(owner.live))
		for id, held := range owner.live {
			copies[position][id] = held
		}
	}
	return copies
}

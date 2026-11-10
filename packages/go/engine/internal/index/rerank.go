package index

import (
	"context"
	"math"
	"slices"
	"strconv"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/cursor"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/projection"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/results"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type RerankScorer func(ctx context.Context, adapter, query string, documents []string) ([]float64, error)

func rerankFusesRankings(params *model.QueryParams) bool {
	return params.Vector != nil && (params.Mode == model.SearchHybrid || strings.TrimSpace(params.Term) != "")
}

func requireRerankReach(cursorDepth, offset, limit int) error {
	reach := cursorDepth + offset + limit
	if reach <= cursor.ResultWindow {
		return nil
	}
	return narsilerr.New(narsilerr.CodeSearchResultWindowExceeded,
		"The engine pages a reranked query through the first "+strconv.Itoa(cursor.ResultWindow)+" results, and this page ends at "+strconv.Itoa(reach),
		map[string]any{"limit": limit, "offset": offset, "cursorDepth": cursorDepth, "window": cursor.ResultWindow})
}

func rerankFirstStageDepth(hybridDepth model.Optional[int], window, cursorDepth, offset, limit int) (int, error) {
	depth, fused := hybridDepth.Get()
	if !fused {
		if err := requireRerankReach(cursorDepth, offset, limit); err != nil {
			return 0, err
		}
		return max(window+1, min(cursorDepth+offset+limit+1, cursor.ResultWindow)), nil
	}
	if err := results.RequireWithinHybridDepth(cursorDepth, offset, depth); err != nil {
		return 0, err
	}
	return depth, nil
}

func reorderByRerank(ranked []model.Hit, windowSize int, scores []float64) []model.Hit {
	initialLow, initialHigh := math.Inf(1), math.Inf(-1)
	finalLow, finalHigh := math.Inf(1), math.Inf(-1)
	ordered := make([]model.Hit, windowSize, len(ranked))
	for at := range windowSize {
		first := ranked[at].Score.Or(0)
		score := scores[at]
		initialLow, initialHigh = min(initialLow, first), max(initialHigh, first)
		finalLow, finalHigh = min(finalLow, score), max(finalHigh, score)
		ordered[at] = ranked[at]
		ordered[at].Score = model.Some(score)
	}
	slices.SortStableFunc(ordered, func(left, right model.Hit) int {
		if difference := right.Score.Or(0) - left.Score.Or(0); difference != 0 {
			if difference > 0 {
				return 1
			}
			return -1
		}
		return strings.Compare(left.ID, right.ID)
	})
	rescale := initialLow > finalLow
	scale, bias := 1.0, 0.0
	if rescale {
		scale = max(finalHigh-finalLow, 1) / max(initialHigh-initialLow, 1)
		bias = finalLow - initialLow*scale
	}
	for _, hit := range ranked[windowSize:] {
		if rescale {
			hit.Score = model.Some(hit.Score.Or(0)*scale + bias)
		}
		ordered = append(ordered, hit)
	}
	return ordered
}

func (ix *Index) rerankCursorDepth(params *model.QueryParams, binding func() string) (int, error) {
	encoded, set := params.SearchAfter.Get()
	if !set {
		return 0, nil
	}
	decoded, err := cursor.DecodePageCursor(encoded)
	if err != nil {
		return 0, err
	}
	if err := cursor.RequireMatchingCursor(decoded, encoded, model.Optional[string]{}, true, binding()); err != nil {
		return 0, err
	}
	return decoded.Depth, nil
}

func toResultHits(hits []model.Hit) []results.Hit {
	converted := make([]results.Hit, len(hits))
	for at, hit := range hits {
		converted[at] = results.Hit{ID: hit.ID, Score: hit.Score, Components: hit.ScoreComponents}
	}
	return converted
}

func toModelHits(hits []results.Hit) []model.Hit {
	converted := make([]model.Hit, len(hits))
	for at, hit := range hits {
		converted[at] = model.Hit{ID: hit.ID, Score: hit.Score, ScoreComponents: hit.Components}
	}
	return converted
}

func (ix *Index) storedPins(pinned []model.PinnedDocument) []model.PinnedDocument {
	stored := map[string]struct{}{}
	for _, entry := range results.DedupePinnedEntries(pinned) {
		if ix.Has(entry.DocID) {
			stored[entry.DocID] = struct{}{}
		}
	}
	kept := make([]model.PinnedDocument, 0, len(pinned))
	for _, entry := range pinned {
		if _, held := stored[entry.DocID]; held {
			kept = append(kept, entry)
		}
	}
	return kept
}

func (ix *Index) rerankTexts(hits []model.Hit, fields []string) []string {
	texts := make([]string, len(hits))
	for at, hit := range hits {
		stored, found := ix.Get(hit.ID)
		if !found {
			continue
		}
		values := make([]any, len(fields))
		for slot, field := range fields {
			values[slot], _ = partition.NestedValue(stored.Fields, field)
		}
		texts[at] = rerankTextOf(values)
	}
	return texts
}

func (ix *Index) fillRerankedDocuments(hits []model.Hit, groups []model.GroupResult, requested model.DocumentProjection) {
	read := func(id string) model.Document {
		if projection.Resolve(requested).Kind() == model.ProjectNoFields {
			return model.Document{}
		}
		document, found := ix.GetProjected(id, requested)
		if !found {
			return model.Document{}
		}
		return document
	}
	for at := range hits {
		hits[at].Document = read(hits[at].ID)
	}
	for _, group := range groups {
		for at := range group.Hits {
			group.Hits[at].Document = read(group.Hits[at].ID)
		}
	}
}

func (ix *Index) highlightReranked(hits []model.Hit, request model.QueryParams) error {
	request.Rerank, request.Pinned, request.SearchAfter = nil, nil, model.Optional[string]{}
	prepared, err := ix.prepareQuery(request)
	if err != nil {
		return err
	}
	pass, err := ix.settings.Analyzer.Prepare()
	if err != nil {
		return err
	}
	if err := ix.analyseQueryTerm(prepared, pass); err != nil {
		return err
	}
	return ix.applyHighlights(hits, newDocumentLookup(ix, nil), prepared, pass)
}

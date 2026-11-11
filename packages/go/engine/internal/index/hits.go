package index

import (
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/query"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type scoredHit struct {
	ID         string
	Score      float64
	Components *model.ScoreComponents
}

type resultHit struct {
	ID         string
	Score      model.Optional[float64]
	Components *model.ScoreComponents
}

func scoreOrZero(hit resultHit) float64 {
	return hit.Score.Or(0)
}

func saturatingAdd(left, right int) int {
	if right > 0 && left > math.MaxInt-right {
		return math.MaxInt
	}
	if right < 0 && left < math.MinInt-right {
		return math.MinInt
	}
	return left + right
}

func mergeScored(lists [][]scoredHit) ([]scoredHit, error) {
	workspace, err := core.AcquireWorkspace()
	if err != nil {
		return nil, err
	}
	defer workspace.Release()
	return query.MergeByScore(workspace, lists, math.MaxUint32,
		func(hit scoredHit) float64 { return hit.Score },
		func(left, right scoredHit) int { return text.CompareCodePoints(left.ID, right.ID) })
}

func emptyComponents() *model.ScoreComponents {
	return &model.ScoreComponents{TermFrequencies: map[string]float64{}, FieldLengths: map[string]float64{}, IDF: map[string]float64{}}
}

func hitsOf(scored []scoredHit, count int, withComponents bool) []resultHit {
	hits := make([]resultHit, count)
	for at := range hits {
		hits[at] = resultHit{ID: scored[at].ID, Score: model.Some(scored[at].Score)}
		if withComponents {
			hits[at].Components = scored[at].Components
			if hits[at].Components == nil {
				hits[at].Components = emptyComponents()
			}
		}
	}
	return hits
}

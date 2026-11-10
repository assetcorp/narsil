package results

import (
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

type Hit struct {
	ID         string
	Score      model.Optional[float64]
	Document   model.Document
	Components *model.ScoreComponents
}

type Scored struct {
	ID         string
	Score      float64
	Components model.ScoreComponents
}

type NormalizedScore struct {
	ID    string
	Score float64
}

func scoreOrZero(hit Hit) float64 {
	return hit.Score.Or(0)
}

func signOfDifference(difference float64) int {
	switch {
	case difference > 0:
		return 1
	case difference < 0:
		return -1
	}
	return 0
}

func descendingScoreOrder(left, right float64) int {
	return signOfDifference(right - left)
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

func relativeIndex(index, length int) int {
	if index < 0 {
		return max(length+index, 0)
	}
	return min(index, length)
}

func sliceLikeJavaScript(hits []Hit, start, end int) []Hit {
	from := relativeIndex(start, len(hits))
	to := relativeIndex(end, len(hits))
	if to <= from {
		return []Hit{}
	}
	return append([]Hit(nil), hits[from:to]...)
}

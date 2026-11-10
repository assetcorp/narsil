package results

import (
	"math"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type ResolvedFusion struct {
	Strategy model.HybridStrategy
	K        int
	Alpha    float64
}

func rankConstantOf(hybrid *model.HybridConfig) (int, error) {
	if hybrid == nil {
		return defaultRankConstant, nil
	}
	k, set := hybrid.K.Get()
	if !set {
		return defaultRankConstant, nil
	}
	if k < minRankConstant {
		return 0, narsilerr.New(
			narsilerr.CodeConfigInvalid,
			"hybrid.k must be a whole number of at least "+text.FormatNumber(minRankConstant),
			map[string]any{"k": k},
		)
	}
	return k, nil
}

func linearAlphaOf(hybrid *model.HybridConfig) (float64, error) {
	if hybrid == nil {
		return defaultLinearAlpha, nil
	}
	alpha, set := hybrid.Alpha.Get()
	if !set {
		return defaultLinearAlpha, nil
	}
	if math.IsNaN(alpha) || math.IsInf(alpha, 0) || alpha < minLinearAlpha || alpha > maxLinearAlpha {
		return 0, narsilerr.New(
			narsilerr.CodeConfigInvalid,
			"hybrid.alpha must be a number from "+text.FormatNumber(minLinearAlpha)+" to "+text.FormatNumber(maxLinearAlpha),
			map[string]any{"alpha": alpha},
		)
	}
	return alpha, nil
}

func ResolveHybridFusion(hybrid *model.HybridConfig) (ResolvedFusion, error) {
	strategy := model.HybridRRF
	if hybrid != nil && hybrid.Strategy != "" {
		strategy = hybrid.Strategy
	}
	if strategy != model.HybridRRF && strategy != model.HybridLinear {
		return ResolvedFusion{}, narsilerr.New(
			narsilerr.CodeConfigInvalid,
			`hybrid.strategy must be "rrf" or "linear"`,
			map[string]any{"strategy": string(strategy)},
		)
	}
	k, err := rankConstantOf(hybrid)
	if err != nil {
		return ResolvedFusion{}, err
	}
	alpha, err := linearAlphaOf(hybrid)
	if err != nil {
		return ResolvedFusion{}, err
	}
	return ResolvedFusion{Strategy: strategy, K: k, Alpha: alpha}, nil
}

func compareFused(left, right Scored) int {
	if order := descendingScoreOrder(left.Score, right.Score); order != 0 {
		return order
	}
	return text.CompareCodePoints(left.ID, right.ID)
}

func ReciprocalRankFusion(lists [][]Scored, k int) []Scored {
	positions := map[string]int{}
	var fused []Scored
	for _, list := range lists {
		for rank, document := range list {
			contribution := 1 / (float64(k) + float64(rank) + 1)
			if position, found := positions[document.ID]; found {
				fused[position].Score += contribution
				continue
			}
			positions[document.ID] = len(fused)
			fused = append(fused, Scored{ID: document.ID, Score: contribution, Components: document.Components})
		}
	}
	slices.SortStableFunc(fused, compareFused)
	return fused
}

func LinearCombination(textResults, vectorResults []Scored, alpha float64) []Scored {
	textScores := map[string]float64{}
	for _, normalized := range MinMaxNormalize(textResults) {
		textScores[normalized.ID] = normalized.Score
	}
	textDocuments := map[string]Scored{}
	for _, document := range textResults {
		textDocuments[document.ID] = document
	}
	vectorScores := map[string]float64{}
	for _, normalized := range MinMaxNormalize(vectorResults) {
		vectorScores[normalized.ID] = normalized.Score
	}
	seen := map[string]struct{}{}
	var fused []Scored
	for _, results := range [][]Scored{textResults, vectorResults} {
		for _, document := range results {
			if _, repeated := seen[document.ID]; repeated {
				continue
			}
			seen[document.ID] = struct{}{}
			combined := float64(alpha*vectorScores[document.ID]) + float64((1-alpha)*textScores[document.ID])
			fused = append(fused, Scored{ID: document.ID, Score: combined, Components: textDocuments[document.ID].Components})
		}
	}
	slices.SortStableFunc(fused, compareFused)
	return fused
}

func MinMaxNormalize(documents []Scored) []NormalizedScore {
	if len(documents) == 0 {
		return []NormalizedScore{}
	}
	lowest, highest := documents[0].Score, documents[0].Score
	for _, document := range documents[1:] {
		if document.Score < lowest {
			lowest = document.Score
		}
		if document.Score > highest {
			highest = document.Score
		}
	}
	spread := highest - lowest
	normalized := make([]NormalizedScore, len(documents))
	for index, document := range documents {
		score := 1.0
		if spread != 0 {
			score = (document.Score - lowest) / spread
		}
		normalized[index] = NormalizedScore{ID: document.ID, Score: score}
	}
	return normalized
}

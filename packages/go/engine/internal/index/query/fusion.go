package query

import (
	"math"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

const (
	DefaultRankConstant = 60
	MinRankConstant     = 1
	DefaultLinearAlpha  = 0.5
	MinLinearAlpha      = 0
	MaxLinearAlpha      = 1
)

type FusionStrategy string

const (
	FusionReciprocalRank FusionStrategy = "rrf"
	FusionLinear         FusionStrategy = "linear"
)

type FusionSettings struct {
	Strategy FusionStrategy
	K        float64
	Alpha    float64
}

type RankedEntry struct {
	ID    string
	Score float64
}

func ResolveFusion(strategy string, k, alpha *float64) (FusionSettings, error) {
	settings := FusionSettings{Strategy: FusionReciprocalRank, K: DefaultRankConstant, Alpha: DefaultLinearAlpha}
	if strategy != "" {
		if strategy != string(FusionReciprocalRank) && strategy != string(FusionLinear) {
			return settings, narsilerr.New(narsilerr.CodeConfigInvalid, `hybrid.strategy must be "rrf" or "linear"`, map[string]any{"strategy": strategy})
		}
		settings.Strategy = FusionStrategy(strategy)
	}
	if k != nil {
		if *k != math.Trunc(*k) || math.IsInf(*k, 0) || *k < MinRankConstant {
			return settings, narsilerr.New(narsilerr.CodeConfigInvalid, "hybrid.k must be a whole number of at least 1", map[string]any{"k": *k})
		}
		settings.K = *k
	}
	if alpha != nil {
		if math.IsNaN(*alpha) || math.IsInf(*alpha, 0) || *alpha < MinLinearAlpha || *alpha > MaxLinearAlpha {
			return settings, narsilerr.New(narsilerr.CodeConfigInvalid, "hybrid.alpha must be a number from 0 to 1", map[string]any{"alpha": *alpha})
		}
		settings.Alpha = *alpha
	}
	return settings, nil
}

func fusionFailure(err error) error {
	if err == nil {
		return narsilerr.New(narsilerr.CodeConfigInvalid, "The hybrid rankings cannot be fused", nil)
	}
	return narsilerr.Wrap(narsilerr.CodeConfigInvalid, "The hybrid rankings cannot be fused", err, nil)
}

func Fuse(textLeg, vectorLeg []RankedEntry, settings FusionSettings) ([]RankedEntry, error) {
	linear := settings.Strategy == FusionLinear
	request := &core.FusionRequest{
		Strategy: core.FusionReciprocalRank, RankConstant: settings.K, Alpha: DefaultLinearAlpha,
		Text:   core.FusionLeg{Keys: make([]uint32, len(textLeg)), Scores: make([]float64, len(textLeg))},
		Vector: core.FusionLeg{Keys: make([]uint32, len(vectorLeg)), Scores: make([]float64, len(vectorLeg))},
	}
	if linear {
		request.Strategy, request.RankConstant, request.Alpha = core.FusionLinear, DefaultRankConstant, settings.Alpha
	}
	positions := make(map[string]uint32, len(textLeg)+len(vectorLeg))
	entries := make([]RankedEntry, 0, len(textLeg)+len(vectorLeg))
	for position, entry := range textLeg {
		positions[entry.ID] = uint32(position)
		request.Text.Keys[position] = uint32(position)
		if linear {
			request.Text.Scores[position] = entry.Score
		}
		entries = append(entries, entry)
	}
	if len(positions) != len(textLeg) {
		return nil, fusionFailure(nil)
	}
	for position, entry := range vectorLeg {
		key, found := positions[entry.ID]
		if !found {
			key = uint32(len(entries))
			positions[entry.ID] = key
			entries = append(entries, entry)
		}
		request.Vector.Keys[position] = key
		if linear {
			request.Vector.Scores[position] = entry.Score
		}
	}
	capacity := len(textLeg) + len(vectorLeg)
	request.IDRanks = make([]uint32, capacity)
	for key := range request.IDRanks {
		request.IDRanks[key] = uint32(key)
	}
	output := &core.FusionOutput{Keys: make([]uint32, capacity), Scores: make([]float64, capacity)}
	workspace, err := core.AcquireWorkspace()
	if err != nil {
		return nil, err
	}
	defer workspace.Release()
	found, err := workspace.Fuse(request, output)
	if err != nil {
		return nil, fusionFailure(err)
	}
	keys, scores := output.Keys[:found], output.Scores[:found]
	for start := 0; start < len(keys); {
		end := start + 1
		for end < len(keys) && scores[end] == scores[start] {
			end++
		}
		slices.SortStableFunc(keys[start:end], func(left, right uint32) int {
			return text.CompareCodePoints(entries[left].ID, entries[right].ID)
		})
		start = end
	}
	fused := make([]RankedEntry, found)
	for position, key := range keys {
		if int(key) >= len(entries) {
			return nil, fusionFailure(nil)
		}
		fused[position] = RankedEntry{ID: entries[key].ID, Score: scores[position]}
	}
	return fused, nil
}

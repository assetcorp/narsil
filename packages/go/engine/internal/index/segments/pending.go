package segments

import (
	"math"
	"runtime/debug"
	"runtime/metrics"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

const (
	uint32Bytes = 4
	uint16Bytes = 2
)

type pendingSize struct {
	documents uint64
	tokens    uint64
	units     uint64
}

func pendingNeeds(fields []core.FieldTokens) pendingSize {
	needed := pendingSize{documents: 1}
	for _, field := range fields {
		for _, record := range field.Tokens {
			needed.tokens++
			needed.units += uint64(record.TermLength)
			if record.SurfaceOffset != core.TokenNoSurface {
				needed.units += uint64(record.SurfaceLength)
			}
		}
	}
	return needed
}

func (s *State) pendingFits(needed pendingSize, empty bool) bool {
	held := func(word int) uint64 {
		if empty {
			return 0
		}
		return uint64(s.Core.PendingHeader[word])
	}
	return held(core.PendingDocuments)+needed.documents <= uint64(len(s.Core.PendingDocuments)) &&
		held(core.PendingTokens)+needed.tokens <= uint64(len(s.Core.PendingTokens)/core.PendingTokenWords) &&
		held(core.PendingUnits)+needed.units <= uint64(len(s.Core.PendingUnits))
}

func grownLength(held int, required, smallest uint64) uint64 {
	if uint64(held) >= required {
		return uint64(held)
	}
	return max(smallest, required*PendingRemovalGrowthFactor)
}

func grown[T uint32 | uint16](held []T, length uint64) []T {
	if uint64(len(held)) >= length {
		return held
	}
	next := make([]T, length)
	copy(next, held)
	return next
}

func processHasRoomFor(bytes uint64) bool {
	limit := debug.SetMemoryLimit(-1)
	if limit <= 0 || limit == math.MaxInt64 {
		return true
	}
	sample := []metrics.Sample{{Name: "/memory/classes/total:bytes"}}
	metrics.Read(sample)
	if sample[0].Value.Kind() != metrics.KindUint64 {
		return true
	}
	return float64(sample[0].Value.Uint64()+bytes) <= FrozenRemovalMaxProcessFraction*float64(limit)
}

func (s *State) growTo(documents, tokens, units uint64) bool {
	state := &s.Core
	documentLength := grownLength(len(state.PendingDocuments), documents, PendingRemovalDocuments)
	tokenLength := grownLength(len(state.PendingTokens), tokens*core.PendingTokenWords,
		PendingRemovalTokens*core.PendingTokenWords)
	unitLength := grownLength(len(state.PendingUnits), units, PendingRemovalUnits)
	bytes := documentLength*uint32Bytes + tokenLength*uint32Bytes + unitLength*uint16Bytes
	if bytes > PendingRemovalGrowthLimitBytes {
		return false
	}
	held := uint64(len(state.PendingDocuments)+len(state.PendingTokens))*uint32Bytes +
		uint64(len(state.PendingUnits))*uint16Bytes
	if bytes > PendingRemovalLowMemoryLimitBytes && !processHasRoomFor(bytes-min(bytes, held)) {
		return false
	}
	state.PendingDocuments = grown(state.PendingDocuments, documentLength)
	state.PendingTokens = grown(state.PendingTokens, tokenLength)
	state.PendingUnits = grown(state.PendingUnits, unitLength)
	return true
}

func (s *State) growPending(fields []core.FieldTokens) error {
	needed := pendingNeeds(fields)
	if needed.units > math.MaxUint32 || needed.tokens > math.MaxUint32 {
		return ErrSegmentFull
	}
	if s.pendingFits(needed, false) {
		return nil
	}
	header := s.Core.PendingHeader
	if s.growTo(uint64(header[core.PendingDocuments])+needed.documents,
		uint64(header[core.PendingTokens])+needed.tokens, uint64(header[core.PendingUnits])+needed.units) ||
		s.pendingFits(needed, true) {
		return nil
	}
	state := &s.Core
	state.PendingDocuments = grown(state.PendingDocuments, needed.documents)
	state.PendingTokens = grown(state.PendingTokens, needed.tokens*core.PendingTokenWords)
	state.PendingUnits = grown(state.PendingUnits, needed.units)
	return nil
}

package partition

import (
	"slices"
	"strings"
	"sync/atomic"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/fields"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/projection"
)

type ColumnRequest struct {
	Path string
	Sort bool
	Mode core.SortMode
}

type KeptColumns struct {
	held atomic.Pointer[[]ColumnRequest]
}

func (k *KeptColumns) List() []ColumnRequest {
	if held := k.held.Load(); held != nil {
		return *held
	}
	return nil
}

func (k *KeptColumns) Add(request ColumnRequest) {
	for {
		current := k.held.Load()
		var next []ColumnRequest
		if current != nil {
			if slices.Contains(*current, request) {
				return
			}
			next = slices.Clone(*current)
		}
		next = append(next, request)
		if k.held.CompareAndSwap(current, &next) {
			return
		}
	}
}

func storedValueReader(document func(ordinal uint32) (storedDocument, bool, error), path string) (func(ordinal uint32) (any, bool), func() error) {
	var failure error
	read := func(ordinal uint32) (any, bool) {
		if failure != nil {
			return nil, false
		}
		stored, held, err := document(ordinal)
		if err != nil || !held {
			failure = err
			return nil, false
		}
		values := codec.NewStoredDocument(stored.encoded, storedDecoding)
		if err := projection.FieldFailure(values, path); err != nil {
			failure = err
			return nil, false
		}
		return NestedValue(values, path)
	}
	return read, func() error { return failure }
}

func buildStored(path string, limits fields.Limits, capacity uint32,
	document func(ordinal uint32) (storedDocument, bool, error)) (*fields.Stored, error) {
	stored, err := fields.NewStored(path, limits)
	if err != nil {
		return nil, err
	}
	read, failure := storedValueReader(document, path)
	if err := stored.Backfill(capacity, read); err != nil {
		stored.Release()
		return nil, err
	}
	if err := failure(); err != nil {
		stored.Release()
		return nil, err
	}
	return stored, nil
}

func (p *Partition) listCapable(path string) bool {
	parsed, declared := p.schema[path]
	return !declared || strings.HasSuffix(string(parsed.Base), "[]")
}

func (p *Partition) sortKey(request ColumnRequest) string {
	return fields.SortColumnKey(request.Path, p.listCapable(request.Path), request.Mode)
}

func holdsColumn(set *fields.Set, request ColumnRequest) bool {
	if !request.Sort {
		return set.Stored(request.Path) != nil
	}
	return set.HoldsSort(request.Path, request.Mode)
}

func (s *side) keepColumns(requests []ColumnRequest) error {
	for _, request := range requests {
		if holdsColumn(s.fields, request) {
			continue
		}
		values, failure := storedValueReader(s.growingDocument, request.Path)
		var err error
		if request.Sort {
			_, err = s.fields.EnsureSort(request.Path, request.Mode, s.capacity, s.liveOrdinals(), values)
		} else {
			_, err = s.fields.EnsureStored(request.Path, s.capacity, values)
		}
		if err != nil {
			return err
		}
		if err := failure(); err != nil {
			return err
		}
	}
	return nil
}

func (s *side) liveOrdinals() []uint32 {
	var ordinals []uint32
	for ordinal := range s.capacity {
		if s.holdsLive(ordinal) {
			ordinals = append(ordinals, ordinal)
		}
	}
	return ordinals
}

func (p *Partition) missingColumns(s *side) []ColumnRequest {
	var missing []ColumnRequest
	for _, request := range p.settings.Kept.List() {
		if !holdsColumn(s.fields, request) {
			missing = append(missing, request)
		}
	}
	return missing
}

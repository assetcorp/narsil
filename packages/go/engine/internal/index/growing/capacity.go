package growing

import (
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

type termNeed struct {
	text  []uint16
	added uint64
}

type uniqueTexts struct {
	keys  map[string]struct{}
	texts [][]uint16
}

func (u *uniqueTexts) add(text []uint16) {
	key := unitsKey(text)
	if _, held := u.keys[key]; held {
		return
	}
	u.keys[key] = struct{}{}
	u.texts = append(u.texts, text)
}

type documentCapacity struct {
	terms     map[string]*termNeed
	order     []string
	surfaces  uniqueTexts
	spellings uniqueTexts
	positions uint64
}

func unitsKey(units []uint16) string {
	bytes := make([]byte, len(units)*2)
	for at, unit := range units {
		bytes[at*2] = byte(unit)
		bytes[at*2+1] = byte(unit >> 8)
	}
	return string(bytes)
}

func textOf(units []uint16, offset, length uint32) ([]uint16, bool) {
	end := uint64(offset) + uint64(length)
	if end > uint64(len(units)) {
		return nil, false
	}
	return units[offset:end], true
}

func measureDocument(fields []core.FieldTokens, partial []uint8) (*documentCapacity, error) {
	capacity := &documentCapacity{
		terms:     map[string]*termNeed{},
		surfaces:  uniqueTexts{keys: map[string]struct{}{}},
		spellings: uniqueTexts{keys: map[string]struct{}{}},
	}
	for index := range fields {
		field := &fields[index]
		if int(field.Field) >= len(partial) {
			return nil, invalidTokens()
		}
		seen := map[string]struct{}{}
		for _, token := range field.Tokens {
			term, ok := textOf(field.Units, token.TermOffset, token.TermLength)
			if !ok {
				return nil, invalidTokens()
			}
			key := unitsKey(term)
			if _, held := seen[key]; !held {
				seen[key] = struct{}{}
				need := capacity.terms[key]
				if need == nil {
					need = &termNeed{text: term}
					capacity.terms[key] = need
					capacity.order = append(capacity.order, key)
				}
				need.added++
			}
			spelling := term
			if token.SurfaceOffset != core.TokenNoSurface && token.SurfaceLength != 0 {
				spelling, ok = textOf(field.Units, token.SurfaceOffset, token.SurfaceLength)
				if !ok {
					return nil, invalidTokens()
				}
			}
			if !slices.Equal(spelling, term) {
				capacity.surfaces.add(spelling)
			}
			if partial[field.Field] != 0 {
				capacity.spellings.add(spelling)
			}
		}
		capacity.positions += uint64(len(field.Tokens)) + uint64(len(seen))
	}
	return capacity, nil
}

func (s *Segment) reservePostings(capacity *documentCapacity) error {
	columns := s.terms
	count := columns.ids.count()
	units := columns.ids.unitsUsed()
	entries := s.postings.end()
	for _, key := range capacity.order {
		need := capacity.terms[key]
		ordinal, found := columns.ids.find(need.text)
		if !found || ordinal >= columns.lengths.len() {
			count++
			units += uint64(len(need.text))
			entries += sliceCapacity(sliceClassFor(need.added))
			continue
		}
		needed := uint64(columns.lengths.values[ordinal]) + need.added
		if needed > sliceCapacity(columns.sliceClass.values[ordinal]) {
			entries += sliceCapacity(sliceClassFor(needed))
		}
	}
	if err := columns.reserve(count, units); err != nil {
		return err
	}
	if err := s.postings.prepareWrite(entries); err != nil {
		return err
	}
	if s.positions != nil {
		return s.positions.prepareWrite(s.positions.end() + capacity.positions)
	}
	return nil
}

func reserveStrings(table *surfaceTable, texts [][]uint16, extra *column[uint32]) error {
	count := table.strings.count()
	units := table.strings.unitsUsed()
	for _, text := range texts {
		if _, found := table.strings.find(text); found {
			continue
		}
		count++
		units += uint64(len(text))
	}
	return table.reserve(count, units, extra)
}

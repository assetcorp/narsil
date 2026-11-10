package filters

import "github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"

func Evaluate(filter *Filter, source Source) (bitset.Bits, error) {
	if filter == nil {
		accepted := bitset.New(source.Capacity())
		accepted.OrWith(source.Live())
		return accepted, nil
	}
	return newEvaluation(filter, source).expression(&filter.root)
}

func MatchingIDs(filter *Filter, source Source) ([]string, error) {
	accepted, err := Evaluate(filter, source)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, accepted.Count())
	accepted.ForEach(func(ordinal uint32) bool {
		if id, found := source.ExternalID(ordinal); found {
			ids = append(ids, id)
		}
		return true
	})
	return ids, nil
}

type Matches struct {
	Count    int
	accepted bitset.Bits
	source   Source
}

func Match(filter *Filter, source Source) (*Matches, error) {
	accepted, err := Evaluate(filter, source)
	if err != nil {
		return nil, err
	}
	live := source.Live()
	count := 0
	accepted.ForEach(func(ordinal uint32) bool {
		if live.Has(ordinal) {
			count++
		}
		return true
	})
	return &Matches{Count: count, accepted: accepted, source: source}, nil
}

func (m *Matches) HasID(id string) bool {
	ordinal, found := m.source.Ordinal(id)
	return found && m.accepted.Has(ordinal)
}

func (m *Matches) HasOrdinal(ordinal uint32) bool {
	return m.accepted.Has(ordinal)
}

package paged

import (
	"sort"
	"strings"
)

func (reader *Reader) sampleWindow(id string) (int, int) {
	sample := reader.Resident.IDSample
	count := int(reader.Head.DocumentCount)
	after := sort.Search(len(sample), func(at int) bool { return strings.Compare(sample[at].ID, id) > 0 })
	from := 0
	if after > 0 {
		from = int(sample[after-1].Position)
	}
	to := count
	if after < len(sample) {
		to = int(sample[after].Position) + 1
	}
	return from, min(to, count)
}

func (reader *Reader) OrdinalOf(id string) (int64, error) {
	if reader.Head.DocumentCount == 0 {
		return -1, nil
	}
	low, high := reader.sampleWindow(id)
	for low < high {
		middle := int(uint(low+high) >> 1)
		ordinal, err := reader.SortedOrdinal(uint32(middle))
		if err != nil {
			return -1, err
		}
		held, err := reader.IDBytes(ordinal)
		if err != nil {
			return -1, err
		}
		switch order := strings.Compare(string(held), id); {
		case order == 0:
			return int64(ordinal), nil
		case order < 0:
			low = middle + 1
		default:
			high = middle
		}
	}
	return -1, nil
}

package query

import (
	"slices"
	"strings"
	"unicode/utf16"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type IDResolver func(segment int, ordinal uint32) (string, bool)

type SortRequest struct {
	Fields    []model.SortField
	Limit     int
	Anchor    []text.SortValue
	AnchorID  string
	Matched   [][]uint32
	IDOf      IDResolver
	Partition int
}

type SortedEntry struct {
	Partition int
	Segment   int
	Ordinal   uint32
	ID        string
	Key       []text.SortValue
}

func MatchedSets(view *View) [][]uint32 {
	matched := make([][]uint32, len(view.Segments))
	for index := range view.Segments {
		matched[index] = newBits(view.Segments[index].capacity())
	}
	return matched
}

func MarkMatched(matched [][]uint32, segment int, ordinal uint32) {
	if segment >= 0 && segment < len(matched) {
		setBit(matched[segment], ordinal)
	}
}

func SortModeOf(field model.SortField) core.SortMode {
	switch text.SortModeOf(text.SortDirection(field.Direction), text.SortMode(field.Mode)) {
	case text.SortModeMax:
		return core.SortMax
	case text.SortModeAvg:
		return core.SortAvg
	case text.SortModeMedian:
		return core.SortMedian
	}
	return core.SortMin
}

func sortDirections(fields []model.SortField) []text.SortDirection {
	directions := make([]text.SortDirection, len(fields))
	for at, field := range fields {
		directions[at] = text.SortDirection(field.Direction)
	}
	return directions
}

func (v *View) sortColumn(segment *Segment, field model.SortField) (*core.SortColumn, error) {
	mode := SortModeOf(field)
	if column := segment.Fields.Sort[SortColumnKey{Field: field.Field, Mode: mode}]; column != nil {
		return column, nil
	}
	if parsed, declared := v.Schema[field.Field]; declared && !strings.HasSuffix(string(parsed.Base), "[]") {
		for _, other := range []core.SortMode{core.SortMin, core.SortMax, core.SortAvg, core.SortMedian} {
			if column := segment.Fields.Sort[SortColumnKey{Field: field.Field, Mode: other}]; column != nil {
				return column, nil
			}
		}
	}
	return nil, narsilerr.New(narsilerr.CodeConfigInvalid, "A sort needs the sort column of its field, which the partition view does not hold", map[string]any{"field": field.Field})
}

func sortValueAt(values *core.SortValues, at int) (text.SortValue, bool) {
	if at >= len(values.Kinds) {
		return text.SortValue{}, false
	}
	switch core.SortKind(values.Kinds[at]) {
	case core.SortMissing:
		return text.MissingSortValue(), true
	case core.SortNumber:
		if at >= len(values.Numbers) {
			return text.SortValue{}, false
		}
		return text.NumberSortValue(values.Numbers[at]), true
	case core.SortFalse:
		return text.BooleanSortValue(false), true
	case core.SortTrue:
		return text.BooleanSortValue(true), true
	case core.SortString:
		if at >= len(values.TextStart) || at >= len(values.TextLength) {
			return text.SortValue{}, false
		}
		start, length := uint64(values.TextStart[at]), uint64(values.TextLength[at])
		if start+length > uint64(len(values.Units)) {
			return text.SortValue{}, false
		}
		return text.StringSortValue(string(utf16.Decode(values.Units[start : start+length]))), true
	}
	return text.SortValue{}, false
}

func corruptSortColumn() error {
	return narsilerr.New(narsilerr.CodePartitionCorrupted, "A sort column of the partition view holds a value outside its regions", nil)
}

func rankOfValue(column *core.SortColumn, value text.SortValue) (int32, error) {
	if value.IsMissing() {
		return core.SortMissingRank, nil
	}
	low, high := 0, len(column.Values.Kinds)
	for low < high {
		middle := int(uint(low+high) >> 1)
		held, valid := sortValueAt(&column.Values, middle)
		if !valid {
			return 0, corruptSortColumn()
		}
		comparison := text.CompareComparableValues(held, value, text.SortAscending)
		if comparison == 0 {
			return int32(middle*2 + 2), nil
		}
		if comparison < 0 {
			low = middle + 1
		} else {
			high = middle
		}
	}
	return int32(low*2 + 1), nil
}

func anchorValues(anchor []text.SortValue, fields int) core.SortValues {
	values := core.SortValues{
		Kinds: make([]uint8, fields), Numbers: make([]float64, fields),
		TextStart: make([]uint32, fields), TextLength: make([]uint32, fields),
	}
	for at := range fields {
		value := text.MissingSortValue()
		if at < len(anchor) {
			value = anchor[at]
		}
		switch value.Kind {
		case text.SortValueNumber:
			values.Kinds[at], values.Numbers[at] = uint8(core.SortNumber), value.Number
		case text.SortValueBoolean:
			values.Kinds[at] = uint8(core.SortFalse)
			if value.Boolean {
				values.Kinds[at] = uint8(core.SortTrue)
			}
		case text.SortValueString:
			units := utf16.Encode([]rune(value.Text))
			values.Kinds[at] = uint8(core.SortString)
			values.TextStart[at], values.TextLength[at] = uint32(len(values.Units)), uint32(len(units))
			values.Units = append(values.Units, units...)
		}
	}
	return values
}

type segmentSort struct {
	view       *View
	request    *SortRequest
	directions []text.SortDirection
	workspace  *core.Workspace
}

func (s *segmentSort) entryAfterAnchor(key []text.SortValue, id string) bool {
	if s.request.Anchor == nil {
		return true
	}
	order := text.CompareComparableKeys(key, s.request.Anchor, s.directions)
	return order > 0 || (order == 0 && text.CompareCodePoints(id, s.request.AnchorID) > 0)
}

func widenedBits(bits []uint32, words int) []uint32 {
	if len(bits) >= words {
		return bits
	}
	widened := make([]uint32, words)
	copy(widened, bits)
	return widened
}

func (s *segmentSort) orderSharedKeys(page []SortedEntry) {
	for start := 0; start < len(page); {
		end := start + 1
		for end < len(page) && text.CompareComparableKeys(page[start].Key, page[end].Key, s.directions) == 0 {
			end++
		}
		if end-start > 1 {
			slices.SortFunc(page[start:end], func(left, right SortedEntry) int {
				return text.CompareCodePoints(left.ID, right.ID)
			})
		}
		start = end
	}
}

func (s *segmentSort) page(index int) ([]SortedEntry, error) {
	segment := &s.view.Segments[index]
	if s.request.Matched != nil && bitsetEmpty(s.request.Matched[index]) {
		return nil, nil
	}
	live, err := segment.liveBits()
	if err != nil {
		return nil, err
	}
	request := &core.SortSelectRequest{Directions: make([]uint8, len(s.request.Fields))}
	columns := make([]*core.SortColumn, len(s.request.Fields))
	for at, field := range s.request.Fields {
		if columns[at], err = s.view.sortColumn(segment, field); err != nil {
			return nil, err
		}
		request.Columns = append(request.Columns, *columns[at])
		if field.Direction == model.SortDescending {
			request.Directions[at] = core.SortDescending
		}
	}
	words := bitsetWords(uint32(len(columns[0].Current.Kinds)))
	request.Live = widenedBits(live, words)
	request.Filter = request.Live
	if s.request.Matched != nil {
		request.Filter = widenedBits(s.request.Matched[index], words)
	}
	if s.request.Anchor != nil {
		request.HasAnchor = true
		request.AnchorRanks = make([]int32, len(columns))
		for at, column := range columns {
			value := text.MissingSortValue()
			if at < len(s.request.Anchor) {
				value = s.request.Anchor[at]
			}
			if request.AnchorRanks[at], err = rankOfValue(column, value); err != nil {
				return nil, err
			}
		}
		request.AnchorValues = anchorValues(s.request.Anchor, len(columns))
	}
	capacity := int(segment.liveDocuments())
	request.Output = make([]uint32, capacity)
	requested := min(s.request.Limit, capacity)
	for {
		request.Limit = uint32(requested)
		count, err := s.workspace.SortSelect(request)
		if err != nil {
			return nil, narsilerr.Wrap(narsilerr.CodeConfigInvalid, "The sorted page could not be selected", err, nil)
		}
		page := make([]SortedEntry, 0, count)
		for _, ordinal := range request.Output[:count] {
			id, known := s.request.IDOf(index, ordinal)
			if !known {
				continue
			}
			key := make([]text.SortValue, len(columns))
			for at, column := range columns {
				value, valid := sortValueAt(&column.Current, int(ordinal))
				if !valid {
					return nil, corruptSortColumn()
				}
				key[at] = value
			}
			if s.entryAfterAnchor(key, id) {
				page = append(page, SortedEntry{Partition: s.request.Partition, Segment: index, Ordinal: ordinal, ID: id, Key: key})
			}
		}
		s.orderSharedKeys(page)
		if len(page) >= s.request.Limit || int(count) < requested || requested == capacity {
			return page[:min(len(page), s.request.Limit)], nil
		}
		requested = min(capacity, max(requested*2, requested+s.request.Limit-len(page)))
	}
}

func SortedPage(view *View, request *SortRequest) ([]SortedEntry, error) {
	if err := validateView(view); err != nil {
		return nil, err
	}
	if request == nil || request.IDOf == nil || (request.Matched != nil && len(request.Matched) != len(view.Segments)) {
		return nil, narsilerr.New(narsilerr.CodeConfigInvalid, "A sorted page needs a document resolver and one matched set per segment", nil)
	}
	if request.Limit <= 0 || len(request.Fields) == 0 {
		return nil, nil
	}
	workspace, err := core.AcquireWorkspace()
	if err != nil {
		return nil, err
	}
	defer workspace.Release()
	sorter := &segmentSort{view: view, request: request, directions: sortDirections(request.Fields), workspace: workspace}
	pages := make([][]SortedEntry, len(view.Segments))
	for index := range view.Segments {
		if pages[index], err = sorter.page(index); err != nil {
			return nil, err
		}
	}
	return MergeSortedEntries(workspace, pages, sorter.directions, request.Limit)
}

func MergeSortedEntries(workspace *core.Workspace, pages [][]SortedEntry, directions []text.SortDirection, limit int) ([]SortedEntry, error) {
	sizes := make([]int, len(pages))
	var flat, only []SortedEntry
	populated := 0
	for index, page := range pages {
		sizes[index] = len(page)
		if len(page) > 0 {
			only = page
			populated++
		}
		flat = append(flat, page...)
	}
	if populated <= 1 {
		return only[:min(len(only), max(0, limit))], nil
	}
	ranks := IDRanks(len(flat), func(left, right int) int {
		if order := text.CompareComparableKeys(flat[left].Key, flat[right].Key, directions); order != 0 {
			return order
		}
		return text.CompareCodePoints(flat[left].ID, flat[right].ID)
	})
	merged, err := MergeSorted(workspace, sizes, ranks, uint64(min(max(0, limit), len(flat))))
	if err != nil {
		return nil, err
	}
	entries := make([]SortedEntry, len(merged))
	for at, entry := range merged {
		entries[at] = pages[entry.List][entry.Index]
	}
	return entries, nil
}

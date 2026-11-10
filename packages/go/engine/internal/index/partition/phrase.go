package partition

import (
	"sort"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/postings"
)

type workTally struct {
	meter   *WorkMeter
	pending int64
}

func (t *workTally) add(units int64) error {
	t.pending += units
	if t.meter != nil && t.pending >= phraseWorkFlushUnits {
		return t.flush()
	}
	return nil
}

func (t *workTally) flush() error {
	units := t.pending
	t.pending = 0
	return t.meter.Add(units)
}

type tokenRows struct {
	list        postings.List
	keys        []uint32
	order       []int
	count       int
	cursor      int
	positionRow int
}

type resolvedPhrase struct {
	phrase     Phrase
	offsets    []int
	rows       []*tokenRows
	entryRows  []*tokenRows
	lead       *tokenRows
	leadOffset int
}

type phraseRows struct {
	phrase  Phrase
	lists   []postings.List
	columns rowColumns
}

type phraseMatches struct {
	matched bitset.Bits
	rows    []phraseRows
}

func tokenRowsOf(list postings.List, tally *workTally) (*tokenRows, error) {
	if !list.HoldsPositions() {
		return nil, nil
	}
	count := list.Length()
	if list.Ordered {
		return &tokenRows{list: list, keys: list.DocIDs, count: count}, nil
	}
	if err := tally.add(int64(count)); err != nil {
		return nil, err
	}
	order := make([]int, count)
	for row := range order {
		order[row] = row
	}
	sort.SliceStable(order, func(left, right int) bool { return list.DocIDs[order[left]] < list.DocIDs[order[right]] })
	keys := make([]uint32, count)
	for at, row := range order {
		keys[at] = list.DocIDs[row]
	}
	return &tokenRows{list: list, keys: keys, order: order, count: count}, nil
}

func (s searcher) resolvePhrase(phrase Phrase, offsets []int, shared map[string]*tokenRows, tally *workTally) (*resolvedPhrase, error) {
	resolved := &resolvedPhrase{phrase: phrase, offsets: offsets}
	for _, token := range phrase.Tokens {
		found := shared[token]
		if found == nil {
			list, present, err := s.src.lookup(token)
			if err != nil || !present {
				return nil, err
			}
			built, err := tokenRowsOf(list, tally)
			if err != nil || built == nil {
				return nil, err
			}
			found = built
			shared[token] = found
		}
		held := false
		for _, existing := range resolved.rows {
			held = held || existing == found
		}
		if !held {
			resolved.rows = append(resolved.rows, found)
		}
		resolved.entryRows = append(resolved.entryRows, found)
	}
	leadEntry := 0
	for entry := 1; entry < len(resolved.entryRows); entry++ {
		if resolved.entryRows[entry].count < resolved.entryRows[leadEntry].count {
			leadEntry = entry
		}
	}
	resolved.lead = resolved.entryRows[leadEntry]
	resolved.leadOffset = offsets[leadEntry]
	return resolved, nil
}

func (rows *tokenRows) firstRowFor(document uint32) int {
	keys, count := rows.keys, rows.count
	low := 0
	if rows.cursor < count && keys[rows.cursor] <= document {
		low = rows.cursor
	}
	high := low
	step := 1
	for high < count && keys[high] < document {
		low = high + 1
		high += step
		step *= 2
	}
	high = min(high, count)
	for low < high {
		middle := int(uint(low+high) >> 1)
		if keys[middle] < document {
			low = middle + 1
		} else {
			high = middle
		}
	}
	rows.cursor = low
	return low
}

func (rows *tokenRows) positionRowFor(document uint32, field uint16) int {
	for at := rows.firstRowFor(document); at < rows.count && rows.keys[at] == document; at++ {
		row := at
		if rows.order != nil {
			row = rows.order[at]
		}
		if rows.list.Fields[row] == field {
			return row
		}
	}
	return -1
}

func countPhraseStarts(resolved *resolvedPhrase, leadRow int, cursors []int, tally *workTally) (int, error) {
	entries := resolved.entryRows
	stores := make([][]uint32, len(entries))
	for entry, rows := range entries {
		stores[entry] = rows.list.PositionsAt(rows.positionRow)
		cursors[entry] = 0
	}
	starts := 0
	for _, position := range resolved.lead.list.PositionsAt(leadRow) {
		anchor := int(position) - resolved.leadOffset
		if anchor < 0 {
			continue
		}
		holdsEveryEntry := true
		for entry := range entries {
			store := stores[entry]
			wanted := anchor + resolved.offsets[entry]
			cursor := cursors[entry]
			compared := int64(1)
			for cursor < len(store) && int(store[cursor]) < wanted {
				cursor++
				compared++
			}
			cursors[entry] = cursor
			if err := tally.add(compared); err != nil {
				return 0, err
			}
			if cursor == len(store) {
				return starts, nil
			}
			if int(store[cursor]) != wanted {
				holdsEveryEntry = false
				break
			}
		}
		if holdsEveryEntry {
			starts++
		}
	}
	return starts, nil
}

func (s searcher) collectPhraseRows(resolved *resolvedPhrase, searchable []uint8, allowed bitset.Bits, hasAllowed bool, keepRows bool, tally *workTally) (bitset.Bits, phraseRows, error) {
	hits := bitset.New(int(s.src.ordinalCapacity()))
	collected := phraseRows{phrase: resolved.phrase}
	for _, rows := range resolved.entryRows {
		collected.lists = append(collected.lists, rows.list)
	}
	lead := resolved.lead
	cursors := make([]int, len(resolved.entryRows))
	for _, each := range resolved.rows {
		each.cursor = 0
	}
	hasDeleted := lead.list.DeadDocuments > 0
	for leadRow := 0; leadRow < lead.count; leadRow++ {
		if err := tally.add(1); err != nil {
			return nil, phraseRows{}, err
		}
		document := lead.list.DocIDs[leadRow]
		field := lead.list.Fields[leadRow]
		if int(field) >= len(searchable) || searchable[field] == 0 {
			continue
		}
		if hasDeleted && s.src.isRemoved(document) || hasAllowed && !allowed.Has(document) {
			continue
		}
		holdsEveryToken := true
		for _, each := range resolved.rows {
			if each == lead {
				each.positionRow = leadRow
				continue
			}
			row := each.positionRowFor(document, field)
			if row == -1 {
				holdsEveryToken = false
				break
			}
			each.positionRow = row
		}
		if !holdsEveryToken {
			continue
		}
		starts, err := countPhraseStarts(resolved, leadRow, cursors, tally)
		if err != nil {
			return nil, phraseRows{}, err
		}
		if starts == 0 {
			continue
		}
		hits.Set(document)
		if keepRows {
			collected.columns.docIDs = append(collected.columns.docIDs, document)
			collected.columns.fields = append(collected.columns.fields, field)
			collected.columns.frequencies = append(collected.columns.frequencies, float64(starts))
		}
	}
	return hits, collected, nil
}

func (s searcher) matchPhrases(phrases []Phrase, searchable []uint8, params *SearchParams, keepRows bool) (*phraseMatches, error) {
	tally := &workTally{meter: params.PhraseWork}
	shared := map[string]*tokenRows{}
	resolved := make([]*resolvedPhrase, 0, len(phrases))
	for _, phrase := range phrases {
		found, err := s.resolvePhrase(phrase, phrase.Offsets, shared, tally)
		if err != nil {
			return nil, err
		}
		if found == nil {
			if err := tally.flush(); err != nil {
				return nil, err
			}
			return &phraseMatches{matched: bitset.New(int(s.src.ordinalCapacity()))}, nil
		}
		resolved = append(resolved, found)
	}
	sort.SliceStable(resolved, func(left, right int) bool { return resolved[left].lead.count < resolved[right].lead.count })
	matches := &phraseMatches{}
	allowed, hasAllowed := params.Filter, params.HasFilter
	for _, each := range resolved {
		hits, rows, err := s.collectPhraseRows(each, searchable, allowed, hasAllowed, keepRows, tally)
		if err != nil {
			return nil, err
		}
		allowed, hasAllowed = hits, true
		matches.rows = append(matches.rows, rows)
		if allowed.IsEmpty() {
			break
		}
	}
	if err := tally.flush(); err != nil {
		return nil, err
	}
	matches.matched = allowed
	if !hasAllowed {
		matches.matched = bitset.New(int(s.src.ordinalCapacity()))
	}
	return matches, nil
}

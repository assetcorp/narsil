package fields

import (
	"cmp"
	"math/bits"
	"slices"
	"unicode/utf8"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	narsiltext "github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type runKey [runCodePoints]rune

type runList struct {
	ids     []uint32
	removed map[uint32]struct{}
	ordered bool
}

type Pattern struct {
	limits       Limits
	runs         map[runKey]*runList
	documents    []uint64
	documentSize uint64
	postingTotal uint64
	folded       []rune
	keys         map[runKey]struct{}
	docIDs       array[uint32]
	runCodes     array[uint32]
	offsets      array[uint32]
	postings     array[uint32]
	built        [4]uint64
	dirty        bool
}

func NewPattern(limits Limits) (*Pattern, error) {
	if err := limits.validate(); err != nil {
		return nil, err
	}
	entries := uint64(limits.MaxEntries)
	return &Pattern{
		limits:   limits,
		runs:     map[runKey]*runList{},
		keys:     map[runKey]struct{}{},
		docIDs:   newArray[uint32]("pattern documents", uint64(limits.MaxOrdinals)),
		runCodes: newArray[uint32]("pattern runs", entries*runCodePoints),
		offsets:  newArray[uint32]("pattern offsets", entries+1),
		postings: newArray[uint32]("pattern postings", entries),
		built:    [4]uint64{0, 0, 1, 0},
		dirty:    true,
	}, nil
}

func holdsTextValue(value any) bool {
	switch value.(type) {
	case string, []any:
		return true
	}
	return false
}

func forEachTextValue(value any, visit func(text string)) {
	switch typed := value.(type) {
	case string:
		visit(typed)
	case []any:
		for _, element := range typed {
			if text, isText := element.(string); isText {
				visit(text)
			}
		}
	}
}

func (p *Pattern) check(path string, value any) error {
	var failure error
	at := 0
	forEachTextValue(value, func(text string) {
		index := -1
		if _, isList := value.([]any); isList {
			index = at
		}
		at++
		if failure != nil {
			return
		}
		if failure = checkText(path, text, index); failure != nil {
			return
		}
		if len(text) > int(p.limits.PatternValueLimit) && utf8.RuneCountInString(text) > int(p.limits.PatternValueLimit) {
			failure = invalidValue(path, "is longer than the pattern value limit of this index",
				map[string]any{"limit": float64(p.limits.PatternValueLimit)})
		}
	})
	return failure
}

func (p *Pattern) collectKeys(value any) {
	clear(p.keys)
	forEachTextValue(value, func(text string) {
		p.folded = narsiltext.AppendFoldedCodePoints(p.folded[:0], text)
		for at := 0; at+runCodePoints <= len(p.folded); at++ {
			p.keys[runKey{p.folded[at], p.folded[at+1], p.folded[at+2]}] = struct{}{}
		}
	})
}

func (p *Pattern) Add(ordinal uint32, value any) error {
	if err := p.limits.checkOrdinal(ordinal); err != nil {
		return err
	}
	if err := p.check("pattern", value); err != nil {
		return err
	}
	if !holdsTextValue(value) {
		return nil
	}
	p.collectKeys(value)
	if needed := p.postingTotal + uint64(len(p.keys)); needed > uint64(p.limits.MaxEntries) {
		return capacityExceeded("pattern postings", needed, uint64(p.limits.MaxEntries))
	}
	p.add(ordinal)
	return nil
}

func (p *Pattern) add(ordinal uint32) {
	p.dirty = true
	word := int(ordinal >> documentWordShift)
	if word >= len(p.documents) {
		p.documents = append(p.documents, make([]uint64, word+1-len(p.documents))...)
	}
	if p.documents[word]&(1<<(ordinal&documentWordMask)) == 0 {
		p.documents[word] |= 1 << (ordinal & documentWordMask)
		p.documentSize++
	}
	for key := range p.keys {
		list, held := p.runs[key]
		if !held {
			list = &runList{ids: make([]uint32, 0, runListInitialCapacity), ordered: true}
			p.runs[key] = list
		}
		if _, removed := list.removed[ordinal]; removed {
			delete(list.removed, ordinal)
			continue
		}
		if len(list.ids) > 0 && list.ids[len(list.ids)-1] > ordinal {
			list.ordered = false
		}
		list.ids = append(list.ids, ordinal)
		p.postingTotal++
	}
}

func (p *Pattern) Remove(ordinal uint32, value any) error {
	if err := p.check("pattern", value); err != nil {
		return err
	}
	if !holdsTextValue(value) {
		return nil
	}
	p.collectKeys(value)
	p.remove(ordinal)
	return nil
}

func (p *Pattern) remove(ordinal uint32) {
	p.dirty = true
	word := int(ordinal >> documentWordShift)
	if word < len(p.documents) && p.documents[word]&(1<<(ordinal&documentWordMask)) != 0 {
		p.documents[word] &^= 1 << (ordinal & documentWordMask)
		p.documentSize--
	}
	for key := range p.keys {
		list, held := p.runs[key]
		if !held {
			continue
		}
		if list.removed == nil {
			list.removed = map[uint32]struct{}{}
		}
		list.removed[ordinal] = struct{}{}
		if len(list.removed)*runListCompactionHalves < len(list.ids) {
			continue
		}
		p.compactRemoved(list)
		p.dropIfEmpty(key, list)
	}
}

func (p *Pattern) compactRemoved(list *runList) {
	if list.removed == nil {
		return
	}
	kept := list.ids[:0]
	for _, ordinal := range list.ids {
		if _, removed := list.removed[ordinal]; !removed {
			kept = append(kept, ordinal)
		}
	}
	p.postingTotal -= uint64(len(list.ids) - len(kept))
	list.ids = kept
	list.removed = nil
}

func (p *Pattern) dropIfEmpty(key runKey, list *runList) {
	if len(list.ids) == 0 {
		delete(p.runs, key)
	}
}

type settledRun struct {
	key runKey
	ids []uint32
}

func (p *Pattern) settledRuns() ([]settledRun, uint64) {
	settled := make([]settledRun, 0, len(p.runs))
	total := uint64(0)
	for key, list := range p.runs {
		p.compactRemoved(list)
		if !list.ordered {
			slices.Sort(list.ids)
			list.ordered = true
		}
		if len(list.ids) == 0 {
			delete(p.runs, key)
			continue
		}
		settled = append(settled, settledRun{key: key, ids: list.ids})
		total += uint64(len(list.ids))
	}
	slices.SortFunc(settled, func(left, right settledRun) int {
		for at := range runCodePoints {
			if difference := cmp.Compare(left.key[at], right.key[at]); difference != 0 {
				return difference
			}
		}
		return 0
	})
	return settled, total
}

func (p *Pattern) reserve(documents, runs, postings uint64) error {
	if err := p.docIDs.reserve(documents, 1); err != nil {
		return err
	}
	if err := p.runCodes.reserve(runs*runCodePoints, 1); err != nil {
		return err
	}
	if err := p.offsets.reserve(runs+1, 1); err != nil {
		return err
	}
	return p.postings.reserve(postings, 1)
}

func (p *Pattern) build() error {
	settled, total := p.settledRuns()
	count := uint64(len(settled))
	if err := p.reserve(p.documentSize, count, total); err != nil {
		return err
	}
	docIDs := p.docIDs.prefix(p.documentSize)
	written := 0
	for word, held := range p.documents {
		for held != 0 {
			docIDs[written] = uint32(word)<<documentWordShift | uint32(bits.TrailingZeros64(held))
			written++
			held &= held - 1
		}
	}
	runs := p.runCodes.prefix(count * runCodePoints)
	offsets := p.offsets.prefix(count + 1)
	postings := p.postings.prefix(total)
	offsets[0] = 0
	posting := uint32(0)
	for at, run := range settled {
		runs[at*runCodePoints], runs[at*runCodePoints+1], runs[at*runCodePoints+2] =
			uint32(run.key[0]), uint32(run.key[1]), uint32(run.key[2])
		posting += uint32(copy(postings[posting:], run.ids))
		offsets[at+1] = posting
	}
	p.built = [4]uint64{p.documentSize, count * runCodePoints, count + 1, total}
	p.dirty = false
	return nil
}

func (p *Pattern) Settle() error {
	if !p.dirty {
		return nil
	}
	return p.build()
}

func (p *Pattern) Index() *core.PatternIndex {
	if p.offsets.capacity == 0 {
		return &core.PatternIndex{Offsets: []uint32{0}}
	}
	return &core.PatternIndex{
		Documents: p.docIDs.prefix(p.built[0]),
		Runs:      p.runCodes.prefix(p.built[1]),
		Offsets:   p.offsets.prefix(p.built[2]),
		Postings:  p.postings.prefix(p.built[3]),
	}
}

func (p *Pattern) Documents() uint64 {
	return p.documentSize
}

func (p *Pattern) RegionBytes() uint64 {
	return p.docIDs.bytes() + p.runCodes.bytes() + p.offsets.bytes() + p.postings.bytes()
}

func (p *Pattern) HostBytes() uint64 {
	bytes := uint64(cap(p.documents)) * documentWordBytes
	for _, list := range p.runs {
		bytes += uint64(cap(list.ids))*4 + uint64(len(list.removed))*hashEntryBytes + runEntryOverheadBytes
	}
	return bytes
}

func (p *Pattern) Release() {
	p.docIDs.release()
	p.runCodes.release()
	p.offsets.release()
	p.postings.release()
	clear(p.runs)
	p.documents = nil
	p.documentSize, p.postingTotal = 0, 0
	p.built = [4]uint64{0, 0, 1, 0}
	p.dirty = true
}

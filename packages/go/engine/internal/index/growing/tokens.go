package growing

import (
	"fmt"
	"math"
	"slices"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type Document struct {
	fields  []core.FieldTokens
	units   []uint16
	failure error
}

func (d *Document) Reset() {
	for at := range d.fields {
		d.fields[at].Tokens = d.fields[at].Tokens[:0]
		d.fields[at].Units = nil
	}
	d.fields = d.fields[:0]
	d.units = d.units[:0]
	d.failure = nil
}

func (d *Document) open(field uint16) (*core.FieldTokens, error) {
	for at := range d.fields {
		if d.fields[at].Field == field {
			return nil, narsilerr.New(narsilerr.CodeConfigInvalid, "A document holds the same text field twice",
				map[string]any{"field": float64(field)})
		}
	}
	if len(d.fields) < cap(d.fields) {
		d.fields = d.fields[:len(d.fields)+1]
		held := &d.fields[len(d.fields)-1]
		held.Field = field
		held.Tokens = held.Tokens[:0]
		return held, nil
	}
	d.fields = append(d.fields, core.FieldTokens{Field: field, Tokens: make([]core.TokenRecord, 0, preparedTokenCapacity)})
	return &d.fields[len(d.fields)-1], nil
}

func (d *Document) AddText(pass *analysis.Pass, options analysis.Options, field uint16, text string) error {
	target, err := d.open(field)
	if err != nil {
		return err
	}
	if err := pass.Visit(text, options, func(token analysis.Token) { d.add(target, token, 0) }); err != nil {
		return err
	}
	return d.failure
}

func (d *Document) AddList(pass *analysis.Pass, options analysis.Options, field uint16, items []string, gap uint32) error {
	target, err := d.open(field)
	if err != nil {
		return err
	}
	offset := uint64(0)
	for _, item := range items {
		last := int64(-1)
		err := pass.Visit(item, options, func(token analysis.Token) {
			d.add(target, token, offset)
			last = int64(token.Position)
		})
		if err != nil {
			return err
		}
		if d.failure != nil {
			return d.failure
		}
		if last >= 0 {
			offset += uint64(last) + 1 + uint64(gap)
		}
	}
	return nil
}

type CoreAnalysis struct {
	Language uint32
	Flags    core.AnalyseFlags
	Stops    *core.StopWordSet
}

func (d *Document) AnalyseText(settings CoreAnalysis, field uint16, text string) error {
	return d.AnalyseList(settings, field, []string{text}, 0)
}

func (d *Document) AnalyseList(settings CoreAnalysis, field uint16, items []string, gap uint32) error {
	target, err := d.open(field)
	if err != nil {
		return err
	}
	analyser, err := core.AcquireAnalyser()
	if err != nil {
		return err
	}
	defer analyser.Release()
	offset := uint64(0)
	for _, item := range items {
		held := len(target.Tokens)
		target.Tokens, d.units, err = analyser.AppendRecords(settings.Language, settings.Flags, item, settings.Stops,
			target.Tokens, d.units)
		if err != nil {
			return err
		}
		added := target.Tokens[held:]
		if len(added) == 0 {
			continue
		}
		highest := uint32(0)
		for _, token := range added {
			highest = max(highest, token.Position)
		}
		last := offset + uint64(highest)
		if last > math.MaxUint32 {
			target.Tokens = target.Tokens[:held]
			return positionRefusal(last)
		}
		for at := range added {
			added[at].Position += uint32(offset)
		}
		offset = last + 1 + uint64(gap)
	}
	return nil
}

func positionRefusal(position uint64) error {
	return narsilerr.New(narsilerr.CodeConfigInvalid,
		fmt.Sprintf("A token position of %d passes the largest position a keyword segment holds", position),
		map[string]any{"position": float64(position), "maxPosition": float64(math.MaxUint32)})
}

func (d *Document) add(target *core.FieldTokens, token analysis.Token, offset uint64) {
	position := offset + uint64(max(token.Position, 0))
	if position > math.MaxUint32 {
		if d.failure == nil {
			d.failure = positionRefusal(position)
		}
		return
	}
	record := core.TokenRecord{Position: uint32(position), SurfaceOffset: core.TokenNoSurface, TermSlot: core.TokenNoTermSlot}
	ok := true
	record.TermOffset, record.TermLength, ok = d.textOffset(token.Term)
	if ok && token.HasSurface {
		record.SurfaceOffset, record.SurfaceLength, ok = d.textOffset(token.Surface)
	}
	if !ok {
		if d.failure == nil {
			d.failure = narsilerr.New(narsilerr.CodeConfigInvalid,
				"A document holds more text than a keyword segment takes in one write", nil)
		}
		return
	}
	target.Tokens = append(target.Tokens, record)
}

func (d *Document) textOffset(text string) (uint32, uint32, bool) {
	start := len(d.units)
	d.units = appendUnits(d.units, text)
	if uint64(len(d.units)) > math.MaxUint32 {
		d.units = d.units[:start]
		return 0, 0, false
	}
	return uint32(start), uint32(len(d.units) - start), true
}

func appendUnits(units []uint16, text string) []uint16 {
	for at := 0; at < len(text); {
		if text[at] < utf8.RuneSelf {
			units = append(units, uint16(text[at]))
			at++
			continue
		}
		r, size := utf8.DecodeRuneInString(text[at:])
		units = utf16.AppendRune(units, r)
		at += size
	}
	return units
}

func (d *Document) Fields() []core.FieldTokens {
	slices.SortFunc(d.fields, func(left, right core.FieldTokens) int { return int(left.Field) - int(right.Field) })
	for at := range d.fields {
		d.fields[at].Units = d.units
	}
	return d.fields
}

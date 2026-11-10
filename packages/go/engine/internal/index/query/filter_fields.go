package query

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

var geoUnitMetres = map[model.DistanceUnit]float64{model.DistanceKilometres: 1000, model.DistanceMiles: 1609.344, model.DistanceMetres: 1}

type fieldPlan struct {
	b      *filterBuilder
	path   string
	field  int
	count  int
	parsed schema.ParsedFieldType
}

func (p *fieldPlan) append() {
	if p.count != 0 {
		p.b.emit(core.FilterAnd, 0, 0, 2)
	}
	p.count++
}

func (p *fieldPlan) numberTest(negated bool, target int, operator core.FilterOperator, values ...float64) {
	if negated {
		p.b.emit(core.FilterPresent, p.field, 0, 0)
	}
	p.b.testNumbers(target, operator, values...)
	if negated {
		p.b.emit(core.FilterAndNot, 0, 0, 0)
	}
	p.append()
}

func (p *fieldPlan) presence(filter *model.FieldFilter) {
	checks := []struct {
		value    model.Optional[bool]
		exists   bool
		inverted bool
	}{
		{filter.Exists, true, false}, {filter.NotExists, true, true},
		{filter.IsNotEmpty, false, false}, {filter.IsEmpty, false, true},
	}
	for _, check := range checks {
		value, set := check.value.Get()
		if !set {
			continue
		}
		p.b.emit(core.FilterPresent, p.field, 0, 0)
		if !check.exists && p.b.segment.Fields.Size[p.path] != nil {
			p.b.testNumbers(p.b.field(p.path, true), core.FilterEq, 0)
			p.b.emit(core.FilterAndNot, 0, 0, 0)
		}
		if value == check.inverted {
			p.b.emit(core.FilterNot, 0, 0, 0)
		}
		p.append()
	}
}

func (p *fieldPlan) geo(filter *model.FieldFilter) {
	if radius := filter.Radius; radius != nil {
		outside := radius.Inside.IsSet() && !radius.Inside.Or(true)
		precision := 0.0
		if radius.HighPrecision {
			precision = 1
		}
		p.numberTest(outside, p.field, core.FilterRadius, radius.Lat, radius.Lon, radius.Distance*geoUnitMetres[radius.Unit], precision)
	}
	if polygon := filter.Polygon; polygon != nil {
		outside := polygon.Inside.IsSet() && !polygon.Inside.Or(true)
		numbers := []float64{float64(len(polygon.Points))}
		for _, point := range polygon.Points {
			numbers = append(numbers, point.Lat, point.Lon)
		}
		p.numberTest(outside, p.field, core.FilterPolygon, numbers...)
	}
}

func (p *fieldPlan) textRange(lower, upper *string, lowerInclusive, upperInclusive bool) error {
	words, err := p.b.textRangeBits(p.path, lower, upper, lowerInclusive, upperInclusive)
	if err != nil {
		return err
	}
	p.b.bitset(words)
	p.append()
	return nil
}

func (p *fieldPlan) ranges(filter *model.FieldFilter) error {
	bounds := []struct {
		bound    model.RangeBound
		operator core.FilterOperator
	}{{filter.Gt, core.FilterGt}, {filter.Gte, core.FilterGte}, {filter.Lt, core.FilterLt}, {filter.Lte, core.FilterLte}}
	for _, entry := range bounds {
		if text, isText := entry.bound.Text(); isText {
			lower := entry.operator == core.FilterGt || entry.operator == core.FilterGte
			var err error
			if lower {
				err = p.textRange(&text, nil, entry.operator == core.FilterGte, false)
			} else {
				err = p.textRange(nil, &text, false, entry.operator == core.FilterLte)
			}
			if err != nil {
				return err
			}
			continue
		}
		if number, isNumber := entry.bound.Number(); isNumber && !p.parsed.Pattern {
			p.numberTest(false, p.field, entry.operator, number)
		}
	}
	low, high := filter.Between.Low, filter.Between.High
	if lowText, isText := low.Text(); isText {
		highText, _ := high.Text()
		return p.textRange(&lowText, &highText, true, true)
	}
	if lowNumber, isNumber := low.Number(); isNumber && !p.parsed.Pattern {
		highNumber, _ := high.Number()
		p.numberTest(false, p.field, core.FilterBetween, lowNumber, highNumber)
	}
	return nil
}

func (p *fieldPlan) equality(value model.FilterValue, negated bool) {
	if !value.IsSet() {
		return
	}
	if negated {
		p.b.emit(core.FilterPresent, p.field, 0, 0)
	}
	if text, isText := value.Text(); isText {
		p.b.testText(p.field, core.FilterEq, text)
	} else {
		p.b.testNumbers(p.field, core.FilterEq, numberOf(value))
	}
	if negated {
		p.b.emit(core.FilterAndNot, 0, 0, 0)
	}
	p.append()
}

func numberOf(value model.FilterValue) float64 {
	if number, isNumber := value.Number(); isNumber {
		return number
	}
	if flag, isBoolean := value.Boolean(); isBoolean && flag {
		return 1
	}
	return 0
}

func (p *fieldPlan) values(filter *model.FieldFilter) {
	p.equality(filter.Eq, false)
	p.equality(filter.Ne, true)
	lists := []struct {
		texts    []string
		negated  bool
		operator core.FilterOperator
	}{{filter.In, false, core.FilterAny}, {filter.Nin, true, core.FilterAny}}
	for _, entry := range lists {
		if entry.texts == nil {
			continue
		}
		if entry.negated {
			p.b.emit(core.FilterPresent, p.field, 0, 0)
		}
		p.b.testTexts(p.field, entry.operator, entry.texts)
		if entry.negated {
			p.b.emit(core.FilterAndNot, 0, 0, 0)
		}
		p.append()
	}
	for _, entry := range []struct {
		text     model.Optional[string]
		operator core.FilterOperator
	}{{filter.StartsWith, core.FilterPrefix}, {filter.EndsWith, core.FilterSuffix}} {
		if text, set := entry.text.Get(); set {
			p.b.testText(p.field, entry.operator, text)
			p.append()
		}
	}
}

func distinctValues(values []model.FilterValue) []model.FilterValue {
	seen := map[model.FilterValue]bool{}
	var kept []model.FilterValue
	for _, value := range values {
		if !seen[value] {
			seen[value] = true
			kept = append(kept, value)
		}
	}
	return kept
}

func (p *fieldPlan) elements(filter *model.FieldFilter) error {
	for _, entry := range []struct {
		values   []model.FilterValue
		operator core.FilterOperator
	}{{filter.MatchesAny, core.FilterAny}, {filter.ContainsAll, core.FilterAll}} {
		if entry.values == nil {
			continue
		}
		distinct := distinctValues(entry.values)
		if p.parsed.Pattern {
			words, err := p.b.patternElements(p.path, distinct, entry.operator == core.FilterAll)
			if err != nil {
				return err
			}
			p.b.bitset(words)
			p.append()
			continue
		}
		if entry.operator == core.FilterAll {
			p.b.emit(core.FilterPresent, p.field, 0, 0)
		}
		firstText := false
		if len(distinct) > 0 {
			_, firstText = distinct[0].Text()
		}
		if p.b.kinds[p.field] == core.FilterKindEnum || firstText {
			texts := make([]string, len(distinct))
			for at, value := range distinct {
				texts[at], _ = value.Text()
			}
			p.b.testTexts(p.field, entry.operator, texts)
		} else {
			numbers := []float64{float64(len(distinct))}
			for _, value := range distinct {
				numbers = append(numbers, numberOf(value))
			}
			p.b.testNumbers(p.field, entry.operator, numbers...)
		}
		if entry.operator == core.FilterAll {
			p.b.emit(core.FilterAnd, 0, 0, 2)
		}
		p.append()
	}
	return nil
}

func (p *fieldPlan) size(size *model.SizeFilter) {
	if size == nil {
		return
	}
	target := p.b.field(p.path, true)
	for _, entry := range []struct {
		value    model.Optional[float64]
		negated  bool
		operator core.FilterOperator
	}{
		{size.Eq, false, core.FilterEq}, {size.Ne, true, core.FilterEq}, {size.Gt, false, core.FilterGt},
		{size.Gte, false, core.FilterGte}, {size.Lt, false, core.FilterLt}, {size.Lte, false, core.FilterLte},
	} {
		if value, set := entry.value.Get(); set {
			p.numberTest(entry.negated, target, entry.operator, value)
		}
	}
	if between, set := size.Between.Get(); set {
		p.numberTest(false, target, core.FilterBetween, between.Low, between.High)
	}
}

func (b *filterBuilder) fieldPlan(path string, filter *model.FieldFilter, parsed schema.ParsedFieldType) error {
	p := &fieldPlan{b: b, path: path, field: b.field(path, false), parsed: parsed}
	p.presence(filter)
	p.geo(filter)
	if err := p.ranges(filter); err != nil {
		return err
	}
	if parsed.Pattern {
		if err := p.patternTests(filter); err != nil {
			return err
		}
	} else {
		p.values(filter)
	}
	if err := p.elements(filter); err != nil {
		return err
	}
	p.size(filter.Size)
	if p.count == 0 {
		b.bitset(b.live)
	}
	return nil
}

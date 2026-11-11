package cursor

import (
	"math"
	"slices"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

const (
	absentTag byte = iota
	nullTag
	falseTag
	trueTag
	numberTag
	stringTag
	listTag
	mapTag
)

const canonicalNaNBits uint64 = 0x7FF8000000000000

const (
	listingFiltersSlot   = 2
	listingBoundSlots    = 16
	uint32ShiftHighByte  = 24
	float64ShiftHighByte = 56
	bitsPerByte          = 8
	lowNibbleMask        = 0x0F
	bitsPerHexDigit      = 4
)

type boundKind uint8

const (
	boundAbsent boundKind = iota
	boundNull
	boundBoolean
	boundNumber
	boundString
	boundList
	boundMap
	boundBinary32List
)

type boundValue struct {
	kind     boundKind
	boolean  bool
	number   float64
	text     string
	list     []boundValue
	entries  []boundEntry
	binary32 []float32
}

type boundEntry struct {
	key   string
	value boundValue
}

func absentValue() boundValue {
	return boundValue{}
}

func booleanValue(value bool) boundValue {
	return boundValue{kind: boundBoolean, boolean: value}
}

func numberValue(value float64) boundValue {
	return boundValue{kind: boundNumber, number: value}
}

func stringValue(value string) boundValue {
	return boundValue{kind: boundString, text: value}
}

func listValue(members []boundValue) boundValue {
	return boundValue{kind: boundList, list: members}
}

func trueWhenSet(value bool) boundValue {
	if value {
		return booleanValue(true)
	}
	return absentValue()
}

func nonEmptyString(value string) boundValue {
	if value == "" {
		return absentValue()
	}
	return stringValue(value)
}

func optionalNumber(value model.Optional[float64]) boundValue {
	if number, set := value.Get(); set {
		return numberValue(number)
	}
	return absentValue()
}

func optionalInteger(value model.Optional[int]) boundValue {
	if number, set := value.Get(); set {
		return numberValue(float64(number))
	}
	return absentValue()
}

func optionalString(value model.Optional[string]) boundValue {
	if text, set := value.Get(); set {
		return stringValue(text)
	}
	return absentValue()
}

func optionalBoolean(value model.Optional[bool]) boundValue {
	if boolean, set := value.Get(); set {
		return booleanValue(boolean)
	}
	return absentValue()
}

func stringList(values []string) boundValue {
	if values == nil {
		return absentValue()
	}
	members := make([]boundValue, len(values))
	for index, value := range values {
		members[index] = stringValue(value)
	}
	return listValue(members)
}

type boundMapBuilder struct {
	entries []boundEntry
}

func (builder *boundMapBuilder) put(key string, value boundValue) {
	if value.kind != boundAbsent {
		builder.entries = append(builder.entries, boundEntry{key: key, value: value})
	}
}

func (builder *boundMapBuilder) value() boundValue {
	if builder.entries == nil {
		builder.entries = []boundEntry{}
	}
	return boundValue{kind: boundMap, entries: builder.entries}
}

type bindingHash struct {
	hash uint32
}

func (stream *bindingHash) writeByte(value byte) {
	stream.hash = (stream.hash ^ uint32(value)) * codec.FNVPrime
}

func (stream *bindingHash) writeUint32(value uint32) {
	for shift := uint32ShiftHighByte; shift >= 0; shift -= bitsPerByte {
		stream.writeByte(byte(value >> shift))
	}
}

func (stream *bindingHash) writeNumber(value float64) {
	bits := math.Float64bits(value)
	if math.IsNaN(value) {
		bits = canonicalNaNBits
	}
	stream.writeByte(numberTag)
	for shift := float64ShiftHighByte; shift >= 0; shift -= bitsPerByte {
		stream.writeByte(byte(bits >> shift))
	}
}

func (stream *bindingHash) writeString(value string) {
	value = text.ToWellFormed(value)
	stream.writeByte(stringTag)
	stream.writeUint32(uint32(len(value)))
	for index := 0; index < len(value); index++ {
		stream.writeByte(value[index])
	}
}

func (stream *bindingHash) writeValue(value boundValue) {
	switch value.kind {
	case boundAbsent:
		stream.writeByte(absentTag)
	case boundNull:
		stream.writeByte(nullTag)
	case boundBoolean:
		if value.boolean {
			stream.writeByte(trueTag)
		} else {
			stream.writeByte(falseTag)
		}
	case boundNumber:
		stream.writeNumber(value.number)
	case boundString:
		stream.writeString(value.text)
	case boundList:
		stream.writeByte(listTag)
		stream.writeUint32(uint32(len(value.list)))
		for _, member := range value.list {
			stream.writeMember(member)
		}
	case boundBinary32List:
		stream.writeByte(listTag)
		stream.writeUint32(uint32(len(value.binary32)))
		for _, element := range value.binary32 {
			stream.writeNumber(float64(element))
		}
	case boundMap:
		entries := slices.Clone(value.entries)
		slices.SortFunc(entries, func(left, right boundEntry) int {
			return text.CompareCodePoints(left.key, right.key)
		})
		stream.writeByte(mapTag)
		stream.writeUint32(uint32(len(entries)))
		for _, entry := range entries {
			stream.writeString(entry.key)
			stream.writeMember(entry.value)
		}
	}
}

func (stream *bindingHash) writeMember(value boundValue) {
	if value.kind == boundAbsent {
		stream.writeByte(nullTag)
		return
	}
	stream.writeValue(value)
}

func bindingOf(values []boundValue) string {
	stream := bindingHash{hash: codec.FNVOffsetBasis}
	for _, value := range values {
		stream.writeValue(value)
	}
	digits := make([]byte, bindingHexDigits)
	for index := range digits {
		shift := uint32(bindingHexDigits-1-index) * bitsPerHexDigit
		digits[index] = lowercaseHexDigits[(stream.hash>>shift)&lowNibbleMask]
	}
	return string(digits)
}

func QueryBindingOf(params model.QueryParams) string {
	values := []boundValue{
		nonEmptyString(params.Term),
		stringList(params.Fields),
		boundFiltersOf(params.Filters),
		boundBoostOf(params.Boost),
		optionalNumber(params.MinScore),
		boundTermMatchOf(params.TermMatch),
		optionalInteger(params.Tolerance),
		optionalInteger(params.PrefixLength),
		trueWhenSet(params.Prefix),
		trueWhenSet(params.PartialWords),
		trueWhenSet(params.Exact),
		boundPinnedOf(params.Pinned),
		nonEmptyString(string(params.Mode)),
		boundHybridOf(params.Hybrid),
		boundVectorOf(params.Vector),
		boundScoringOf(params.Scoring),
	}
	if params.Rerank != nil {
		values = append(values, boundRerankOf(params.Rerank))
	}
	if bm25SetsValue(params.BM25) {
		values = append(values, boundBM25Of(params.BM25))
	}
	return bindingOf(values)
}

type QueryBinding struct {
	once   sync.Once
	params model.QueryParams
	text   string
}

func NewQueryBinding(params model.QueryParams) *QueryBinding {
	return &QueryBinding{params: params}
}

func (b *QueryBinding) Text() string {
	b.once.Do(func() { b.text = QueryBindingOf(b.params) })
	return b.text
}

func ListBindingOf(filters *model.FilterExpression) string {
	values := make([]boundValue, listingBoundSlots)
	values[listingFiltersSlot] = boundFiltersOf(filters)
	return bindingOf(values)
}

package model

type FilterValueKind uint8

const (
	FilterValueAbsent FilterValueKind = iota
	FilterValueNumber
	FilterValueText
	FilterValueBoolean
)

type FilterValue struct {
	kind    FilterValueKind
	number  float64
	text    string
	boolean bool
}

func NumberValue(number float64) FilterValue {
	return FilterValue{kind: FilterValueNumber, number: number}
}

func TextValue(text string) FilterValue {
	return FilterValue{kind: FilterValueText, text: text}
}

func BooleanValue(boolean bool) FilterValue {
	return FilterValue{kind: FilterValueBoolean, boolean: boolean}
}

func (v FilterValue) Kind() FilterValueKind {
	return v.kind
}

func (v FilterValue) IsSet() bool {
	return v.kind != FilterValueAbsent
}

func (v FilterValue) Number() (float64, bool) {
	return v.number, v.kind == FilterValueNumber
}

func (v FilterValue) Text() (string, bool) {
	return v.text, v.kind == FilterValueText
}

func (v FilterValue) Boolean() (bool, bool) {
	return v.boolean, v.kind == FilterValueBoolean
}

type RangeBoundKind uint8

const (
	RangeBoundAbsent RangeBoundKind = iota
	RangeBoundNumber
	RangeBoundText
)

type RangeBound struct {
	kind   RangeBoundKind
	number float64
	text   string
}

func NumberBound(number float64) RangeBound {
	return RangeBound{kind: RangeBoundNumber, number: number}
}

func TextBound(text string) RangeBound {
	return RangeBound{kind: RangeBoundText, text: text}
}

func (b RangeBound) Kind() RangeBoundKind {
	return b.kind
}

func (b RangeBound) IsSet() bool {
	return b.kind != RangeBoundAbsent
}

func (b RangeBound) Number() (float64, bool) {
	return b.number, b.kind == RangeBoundNumber
}

func (b RangeBound) Text() (string, bool) {
	return b.text, b.kind == RangeBoundText
}

type RangeInterval struct {
	Low  RangeBound
	High RangeBound
}

func (r RangeInterval) IsSet() bool {
	return r.Low.IsSet() || r.High.IsSet()
}

type NumberInterval struct {
	Low  float64
	High float64
}

type SizeFilter struct {
	Eq      Optional[float64]
	Ne      Optional[float64]
	Gt      Optional[float64]
	Lt      Optional[float64]
	Gte     Optional[float64]
	Lte     Optional[float64]
	Between Optional[NumberInterval]
}

type PatternToleranceKind uint8

const (
	PatternToleranceAbsent PatternToleranceKind = iota
	PatternToleranceEdits
	PatternToleranceAuto
)

type PatternTolerance struct {
	kind  PatternToleranceKind
	edits int
}

func ToleranceEdits(edits int) PatternTolerance {
	return PatternTolerance{kind: PatternToleranceEdits, edits: edits}
}

func ToleranceAuto() PatternTolerance {
	return PatternTolerance{kind: PatternToleranceAuto}
}

func (t PatternTolerance) Kind() PatternToleranceKind {
	return t.kind
}

func (t PatternTolerance) Edits() (int, bool) {
	return t.edits, t.kind == PatternToleranceEdits
}

type DistanceUnit string

const (
	DistanceKilometres DistanceUnit = "km"
	DistanceMiles      DistanceUnit = "mi"
	DistanceMetres     DistanceUnit = "m"
)

type GeoPoint struct {
	Lat float64
	Lon float64
}

type GeoRadius struct {
	Lat           float64
	Lon           float64
	Distance      float64
	Unit          DistanceUnit
	Inside        Optional[bool]
	HighPrecision bool
}

type GeoPolygon struct {
	Points []GeoPoint
	Inside Optional[bool]
}

type FieldFilter struct {
	Eq          FilterValue
	Ne          FilterValue
	Gt          RangeBound
	Lt          RangeBound
	Gte         RangeBound
	Lte         RangeBound
	Between     RangeInterval
	In          []string
	Nin         []string
	StartsWith  Optional[string]
	EndsWith    Optional[string]
	Contains    Optional[string]
	Wildcard    Optional[string]
	Regex       Optional[string]
	CaseFold    bool
	Tolerance   PatternTolerance
	ContainsAll []FilterValue
	MatchesAny  []FilterValue
	Size        *SizeFilter
	Exists      Optional[bool]
	NotExists   Optional[bool]
	IsEmpty     Optional[bool]
	IsNotEmpty  Optional[bool]
	Radius      *GeoRadius
	Polygon     *GeoPolygon
}

type FilterExpression struct {
	Fields map[string]FieldFilter
	And    []FilterExpression
	Or     []FilterExpression
	Not    *FilterExpression
}

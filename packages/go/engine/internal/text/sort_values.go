package text

type SortDirection string

const (
	SortAscending  SortDirection = "asc"
	SortDescending SortDirection = "desc"
)

type SortMode string

const (
	SortModeMin    SortMode = "min"
	SortModeMax    SortMode = "max"
	SortModeAvg    SortMode = "avg"
	SortModeMedian SortMode = "median"
)

func SortModes() []SortMode {
	return []SortMode{SortModeMin, SortModeMax, SortModeAvg, SortModeMedian}
}

func IsSortMode(value string) bool {
	switch SortMode(value) {
	case SortModeMin, SortModeMax, SortModeAvg, SortModeMedian:
		return true
	}
	return false
}

func DefaultSortMode(direction SortDirection) SortMode {
	if direction == SortDescending {
		return SortModeMax
	}
	return SortModeMin
}

func SortModeOf(direction SortDirection, mode SortMode) SortMode {
	if mode == "" {
		return DefaultSortMode(direction)
	}
	return mode
}

type SortValueKind uint8

const (
	SortValueMissing SortValueKind = iota
	SortValueNumber
	SortValueString
	SortValueBoolean
)

type SortValue struct {
	Kind    SortValueKind
	Number  float64
	Text    string
	Boolean bool
}

func MissingSortValue() SortValue {
	return SortValue{Kind: SortValueMissing}
}

func NumberSortValue(number float64) SortValue {
	return SortValue{Kind: SortValueNumber, Number: number}
}

func StringSortValue(value string) SortValue {
	return SortValue{Kind: SortValueString, Text: value}
}

func BooleanSortValue(value bool) SortValue {
	return SortValue{Kind: SortValueBoolean, Boolean: value}
}

func (value SortValue) IsMissing() bool {
	return value.Kind == SortValueMissing
}

func TruncateSortString(value string) string {
	return TruncateCodePoints(value, SortValueMaxCodePoints)
}

func compareFloats(left, right float64) int {
	if left < right {
		return -1
	}
	if left > right {
		return 1
	}
	return 0
}

func typeRank(value SortValue) int {
	switch value.Kind {
	case SortValueNumber:
		return 0
	case SortValueString:
		return 1
	}
	return 2
}

func comparePresentValues(left, right SortValue) int {
	if difference := typeRank(left) - typeRank(right); difference != 0 {
		return difference
	}
	switch left.Kind {
	case SortValueNumber:
		return compareFloats(left.Number, right.Number)
	case SortValueString:
		return CompareSortStrings(left.Text, right.Text)
	}
	if left.Boolean == right.Boolean {
		return 0
	}
	if left.Boolean {
		return 1
	}
	return -1
}

func CompareComparableValues(left, right SortValue, direction SortDirection) int {
	switch {
	case left.IsMissing() && right.IsMissing():
		return 0
	case left.IsMissing():
		return 1
	case right.IsMissing():
		return -1
	}
	comparison := comparePresentValues(left, right)
	if direction == SortDescending {
		return -comparison
	}
	return comparison
}

func sortValueAt(values []SortValue, index int) SortValue {
	if index < len(values) {
		return values[index]
	}
	return MissingSortValue()
}

func CompareComparableKeys(left, right []SortValue, directions []SortDirection) int {
	for index, direction := range directions {
		if comparison := CompareComparableValues(sortValueAt(left, index), sortValueAt(right, index), direction); comparison != 0 {
			return comparison
		}
	}
	return 0
}

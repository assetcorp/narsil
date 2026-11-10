package text

import (
	"math"
	"slices"
	"strconv"
	"strings"
)

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

func ToComparableSortValue(value any) SortValue {
	switch typed := value.(type) {
	case string:
		return StringSortValue(TruncateSortString(typed))
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return MissingSortValue()
		}
		return NumberSortValue(typed)
	case bool:
		return BooleanSortValue(typed)
	}
	return MissingSortValue()
}

func numericReduction(values []any, mode SortMode) SortValue {
	numbers := make([]float64, 0, len(values))
	for _, element := range values {
		if number, isNumber := element.(float64); isNumber && !math.IsNaN(number) && !math.IsInf(number, 0) {
			numbers = append(numbers, number)
		}
	}
	if len(numbers) == 0 {
		return MissingSortValue()
	}
	if mode == SortModeAvg {
		mean := 0.0
		for index, number := range numbers {
			mean += (number - mean) / float64(index+1)
		}
		return NumberSortValue(mean)
	}
	slices.SortStableFunc(numbers, compareFloats)
	middle := len(numbers) >> 1
	if len(numbers)%2 == 1 {
		return NumberSortValue(numbers[middle])
	}
	return NumberSortValue(numbers[middle-1]/2 + numbers[middle]/2)
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

func ToReducedSortValue(value any, mode SortMode) SortValue {
	list, isList := value.([]any)
	if !isList {
		return ToComparableSortValue(value)
	}
	if mode == SortModeAvg || mode == SortModeMedian {
		return numericReduction(list, mode)
	}
	chosen := MissingSortValue()
	for _, element := range list {
		comparable := ToComparableSortValue(element)
		if comparable.IsMissing() {
			continue
		}
		if chosen.IsMissing() {
			chosen = comparable
			continue
		}
		comparison := comparePresentValues(comparable, chosen)
		if (mode == SortModeMin && comparison < 0) || (mode != SortModeMin && comparison > 0) {
			chosen = comparable
		}
	}
	return chosen
}

func canonicalArrayIndex(segment string, length int) (int, bool) {
	if segment == "" || (len(segment) > 1 && segment[0] == '0') {
		return 0, false
	}
	for index := 0; index < len(segment); index++ {
		if segment[index] < '0' || segment[index] > '9' {
			return 0, false
		}
	}
	position, err := strconv.Atoi(segment)
	if err != nil || position >= length {
		return 0, false
	}
	return position, true
}

func ownProperty(container any, segment string) (any, bool) {
	switch typed := container.(type) {
	case map[string]any:
		value, found := typed[segment]
		return value, found
	case []any:
		if segment == "length" {
			return float64(len(typed)), true
		}
		if position, found := canonicalArrayIndex(segment, len(typed)); found {
			return typed[position], true
		}
	case []byte:
		if position, found := canonicalArrayIndex(segment, len(typed)); found {
			return float64(typed[position]), true
		}
	case []float32:
		if position, found := canonicalArrayIndex(segment, len(typed)); found {
			return float64(typed[position]), true
		}
	}
	return nil, false
}

func ReadSortField(document map[string]any, path string) (any, bool) {
	var current any = document
	for segment := range strings.SplitSeq(path, ".") {
		value, found := ownProperty(current, segment)
		if !found {
			return nil, false
		}
		current = value
	}
	return current, true
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

func rawValueAt(values []any, index int) any {
	if index < len(values) {
		return values[index]
	}
	return nil
}

func CompareSortValues(left, right []any, directions []SortDirection) int {
	for index, direction := range directions {
		comparison := CompareComparableValues(
			ToComparableSortValue(rawValueAt(left, index)),
			ToComparableSortValue(rawValueAt(right, index)),
			direction,
		)
		if comparison != 0 {
			return comparison
		}
	}
	return 0
}

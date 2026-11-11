package pattern

import (
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type Operator string

const (
	OperatorWildcard Operator = "wildcard"
	OperatorRegex    Operator = "regex"
)

type nodeKind uint8

const (
	nodeLiteral nodeKind = iota
	nodeAny
	nodeClass
	nodeSet
	nodeAssert
	nodeSequence
	nodeChoice
	nodeRepeat
	nodeNumberRange
)

const unboundedRepeat = -1

type setItemKind uint8

const (
	setMember setItemKind = iota
	setRange
	setClass
)

type setItem struct {
	kind      setItemKind
	codePoint rune
}

type node struct {
	kind      nodeKind
	codePoint rune
	negated   bool
	setItems  []setItem
	children  []*node
	body      *node
	min       int
	max       int
}

type expressionLabel struct {
	operator  Operator
	fieldPath string
}

func (label expressionLabel) describe() string {
	return `the "` + string(label.operator) + `" pattern on pattern field "` + label.fieldPath + `"`
}

func (label expressionLabel) refusal(reason string, at int) error {
	return narsilerr.New(narsilerr.CodeSearchInvalidFilter,
		"The engine refuses "+label.describe()+" at code point "+strconv.Itoa(at+1)+". The pattern "+reason,
		map[string]any{"fieldPath": label.fieldPath, "operator": string(label.operator), "codePoint": at + 1})
}

func (label expressionLabel) tooManyPositions(caseFold bool) error {
	folding := ""
	if caseFold {
		folding = " once the engine folds its case"
	}
	return narsilerr.New(narsilerr.CodeSearchInvalidFilter,
		"The engine refuses "+label.describe()+" before it builds a matcher, because the pattern holds more than "+
			strconv.Itoa(MaxPositions)+" positions"+folding+
			". A literal code point, a class, and a set each count as one position. A count such as {5} multiplies the positions of what it repeats. A number range counts the positions of the pattern that it stands for",
		map[string]any{"fieldPath": label.fieldPath, "operator": string(label.operator), "limit": MaxPositions})
}

type parseFailure struct {
	reason string
	at     int
}

const trailingEscape = `ends in a "\" with no code point after it`

func quoted(value string) string {
	return `"` + value + `"`
}

func parseWildcard(codePoints []rune) (*node, *parseFailure) {
	items := []*node{{kind: nodeAssert}}
	for at := 0; at < len(codePoints); at++ {
		codePoint := codePoints[at]
		switch codePoint {
		case '*':
			items = append(items, &node{kind: nodeRepeat, body: &node{kind: nodeAny}, min: 0, max: unboundedRepeat})
		case '?':
			items = append(items, &node{kind: nodeAny})
		case '\\':
			if at+1 == len(codePoints) {
				return nil, &parseFailure{trailingEscape, at}
			}
			at++
			items = append(items, &node{kind: nodeLiteral, codePoint: codePoints[at]})
		default:
			items = append(items, &node{kind: nodeLiteral, codePoint: codePoint})
		}
	}
	items = append(items, &node{kind: nodeAssert})
	return &node{kind: nodeSequence, children: items}, nil
}

func parsedWithinLimits(label expressionLabel, source string, caseFold bool) error {
	codePoints := []rune(source)
	var parsed *node
	var failure *parseFailure
	if label.operator == OperatorRegex {
		parsed, failure = parseRegex(codePoints)
	} else {
		parsed, failure = parseWildcard(codePoints)
	}
	if failure != nil {
		return label.refusal(failure.reason, failure.at)
	}
	if patternPositions(parsed, caseFold) > MaxPositions {
		return label.tooManyPositions(caseFold)
	}
	return nil
}

func checkExpression(operator Operator, source string, caseFold bool, fieldPath string) error {
	return parsedWithinLimits(expressionLabel{operator: operator, fieldPath: fieldPath}, source, caseFold)
}

package keyword

import (
	"math"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type Checker struct {
	prefix string
	err    error
}

func NewChecker(prefix string) *Checker {
	return &Checker{prefix: prefix}
}

func itoa(value int) string {
	return strconv.Itoa(value)
}

func (checker *Checker) Err() error {
	return checker.err
}

func (checker *Checker) Failed() bool {
	return checker.err != nil
}

func (checker *Checker) Fail(message string, details map[string]any) {
	if checker.err == nil {
		checker.err = narsilerr.New(narsilerr.CodePersistenceLoadFailed, checker.prefix+message, details)
	}
}

func (checker *Checker) Record(value any, name string) map[string]any {
	record, ok := value.(map[string]any)
	if !ok {
		checker.Fail(name+" must be a map", nil)
	}
	return record
}

func (checker *Checker) List(value any, name string) []any {
	list, ok := value.([]any)
	if !ok {
		checker.Fail(name+" must be a list", nil)
	}
	return list
}

func (checker *Checker) String(value any, name string) string {
	text, ok := value.(string)
	if !ok {
		checker.Fail(name+" must be a string", nil)
	}
	return text
}

func (checker *Checker) Strings(value any, name string) []string {
	list := checker.List(value, name)
	texts := make([]string, 0, len(list))
	for _, element := range list {
		text, ok := element.(string)
		if !ok {
			checker.Fail(name+" must hold strings alone", nil)
			return nil
		}
		texts = append(texts, text)
	}
	return texts
}

func (checker *Checker) Bytes(value any, name string, width int) []byte {
	bytes, ok := value.([]byte)
	if !ok {
		checker.Fail(name+" must be bytes", nil)
		return nil
	}
	if len(bytes)%width != 0 {
		checker.Fail(name+" holds "+itoa(len(bytes))+" bytes, which is not a whole number of "+itoa(width)+
			"-byte values", map[string]any{"field": name})
		return nil
	}
	return bytes
}

func (checker *Checker) BytesOrNil(value any, name string, width int) ([]byte, bool) {
	if value == nil {
		return nil, false
	}
	return checker.Bytes(value, name, width), true
}

func (checker *Checker) Uint32(value any, name string) uint32 {
	number, ok := value.(float64)
	if !ok || number < 0 || number > math.MaxUint32 || number != math.Trunc(number) {
		checker.Fail(name+" must be a uint32", nil)
		return 0
	}
	return uint32(number)
}

func (checker *Checker) Count(found int, expected int, name string) {
	if checker.err != nil || found == expected {
		return
	}
	checker.Fail(name+" holds "+itoa(found)+" values where the segment needs "+itoa(expected),
		map[string]any{"field": name, "found": found, "expected": expected})
}

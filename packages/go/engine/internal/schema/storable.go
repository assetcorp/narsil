package schema

import (
	"fmt"
	"reflect"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

var reservedObjectKeys = map[string]bool{"__proto__": true, "constructor": true, "prototype": true}

const maxJavaScriptDateSeconds = MaxJavaScriptDateMs / 1000

func rejectStored(path, reason string) error {
	subject := path
	if subject == "" {
		subject = "(document)"
	}
	return narsilerr.New(narsilerr.CodeDocValidationFailed, fmt.Sprintf("Field %q %s", subject, reason), map[string]any{"field": path})
}

func isJavaScriptDate(moment time.Time) bool {
	seconds := moment.Unix()
	if seconds > maxJavaScriptDateSeconds || seconds < -maxJavaScriptDateSeconds-1 {
		return false
	}
	milliseconds := seconds*1000 + int64(moment.Nanosecond()/1_000_000)
	return milliseconds >= -MaxJavaScriptDateMs && milliseconds <= MaxJavaScriptDateMs
}

type storableWalk struct {
	skip map[string]int
}

func AssertStorableDocument(document *model.Document, parsed *Parsed) error {
	if document == nil {
		return documentRequired()
	}
	walk := storableWalk{}
	if parsed != nil {
		walk.skip = parsed.vectors
	}
	return walk.value(document, "", 0)
}

func nestsTooDeep(path string) error {
	return rejectStored(path, fmt.Sprintf("nests deeper than %d levels", MaxDocumentNestingDepth))
}

func (w storableWalk) value(value any, path string, depth int) error {
	switch typed := value.(type) {
	case nil, bool, float64, []byte:
		return nil
	case string:
		if !utf8.ValidString(typed) {
			return rejectStored(path, unpairedSurrogateReason)
		}
		return nil
	case time.Time:
		if !isJavaScriptDate(typed) {
			return rejectStored(path, "holds an invalid date, which the engine cannot store")
		}
		return nil
	case []any:
		if depth >= MaxDocumentNestingDepth {
			return nestsTooDeep(path)
		}
		for i, item := range typed {
			if err := w.value(item, path+"["+strconv.Itoa(i)+"]", depth+1); err != nil {
				return err
			}
		}
		return nil
	case *model.Document:
		if depth >= MaxDocumentNestingDepth {
			return nestsTooDeep(path)
		}
		return w.object(typed, path, depth)
	}
	return w.unsupported(value, path, depth)
}

func (w storableWalk) object(values *model.Document, path string, depth int) error {
	for key, value := range codec.HeldEntries(values) {
		keyPath := joinPath(path, key)
		if reservedObjectKeys[key] {
			return rejectStored(keyPath, "uses a reserved object key")
		}
		if !utf8.ValidString(key) {
			return rejectStored(keyPath, "has a name that "+unpairedSurrogateReason)
		}
		if _, isVector := w.skip[keyPath]; isVector {
			continue
		}
		if err := w.value(value, keyPath, depth+1); err != nil {
			return err
		}
	}
	return nil
}

func (w storableWalk) unsupported(value any, path string, depth int) error {
	reflected := reflect.ValueOf(value)
	switch reflected.Kind() {
	case reflect.Map, reflect.Slice, reflect.Array:
		if depth >= MaxDocumentNestingDepth {
			return nestsTooDeep(path)
		}
	case reflect.Func, reflect.Chan, reflect.Complex64, reflect.Complex128, reflect.UnsafePointer:
		return rejectStored(path, fmt.Sprintf("holds a %s, which cannot be stored or recovered", reflected.Kind()))
	}
	return rejectStored(path, "holds a value that does not survive storage; use maps, lists, strings, numbers, booleans, times, or byte slices")
}

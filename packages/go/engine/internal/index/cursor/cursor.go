package cursor

import (
	"math"
	"unicode/utf16"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

const (
	cursorVersion       = 4
	bindingHexDigits    = 8
	maxSafeInteger      = 1<<53 - 1
	invalidCursorPrefix = "Failed to decode cursor: "
	shownCursorEllipsis = "..."
)

type PageCursor struct {
	Anchor        string
	Score         model.Optional[float64]
	SortKey       []text.SortValue
	SortSignature model.Optional[string]
	Depth         int
	Binding       string
}

func leadingUTF16Units(value string, limit int) (string, bool) {
	if len(value) <= limit {
		return value, false
	}
	units := make([]uint16, 0, limit+1)
	at := 0
	for at < len(value) && len(units) < limit {
		codePoint, size := text.NextCodePoint(value, at)
		units = utf16.AppendRune(units, codePoint)
		at += size
	}
	if at >= len(value) && len(units) <= limit {
		return value, false
	}
	return text.DecodeUTF16(units[:limit]), true
}

func shownCursor(encoded string) string {
	shown, shortened := leadingUTF16Units(encoded, shownCursorUnits)
	if shortened {
		return shown + shownCursorEllipsis
	}
	return shown
}

func invalidCursor(encoded, reason string) *narsilerr.Error {
	return narsilerr.New(narsilerr.CodeSearchInvalidCursor, invalidCursorPrefix+reason, map[string]any{"cursor": shownCursor(encoded)})
}

func EncodePageCursor(cursor PageCursor) string {
	payload := make([]byte, 0, initialCursorPayloadBytes)
	payload = append(payload, `{"v":`...)
	payload = text.AppendNumber(payload, cursorVersion)
	payload = append(payload, `,"a":`...)
	payload = appendJSONString(payload, cursor.Anchor)
	if signature, sorted := cursor.SortSignature.Get(); sorted {
		payload = append(payload, `,"k":[`...)
		for index, value := range cursor.SortKey {
			if index > 0 {
				payload = append(payload, ',')
			}
			payload = appendJSONSortValue(payload, value)
		}
		payload = append(payload, `],"o":`...)
		payload = appendJSONString(payload, signature)
	} else if score, scored := cursor.Score.Get(); scored {
		payload = append(payload, `,"s":`...)
		payload = appendJSONNumber(payload, score)
	}
	if cursor.Depth > 0 {
		payload = append(payload, `,"d":`...)
		payload = text.AppendNumber(payload, float64(cursor.Depth))
	}
	payload = append(payload, `,"q":`...)
	payload = appendJSONString(payload, cursor.Binding)
	payload = append(payload, '}')
	return codec.EncodeBase64(payload)
}

func isFinite(number float64) bool {
	return !math.IsNaN(number) && !math.IsInf(number, 0)
}

func isSafeInteger(number float64) bool {
	return isFinite(number) && math.Trunc(number) == number && math.Abs(number) <= maxSafeInteger
}

func isBindingText(value string) bool {
	if len(value) != bindingHexDigits {
		return false
	}
	for index := 0; index < len(value); index++ {
		if !isDigit(value[index]) && (value[index] < 'a' || value[index] > 'f') {
			return false
		}
	}
	return true
}

func decodeSortKey(value jsonValue, encoded string) ([]text.SortValue, error) {
	if value.kind != jsonArray {
		return nil, invalidCursor(encoded, `"k" must be an array`)
	}
	if len(value.items) > maxSortFields {
		return nil, invalidCursor(encoded, `"k" carries too many sort values`)
	}
	key := make([]text.SortValue, 0, len(value.items))
	for _, entry := range value.items {
		switch entry.kind {
		case jsonNull:
			key = append(key, text.MissingSortValue())
		case jsonTrue, jsonFalse:
			key = append(key, text.BooleanSortValue(entry.kind == jsonTrue))
		case jsonNumber:
			if !isFinite(entry.number) {
				return nil, invalidCursor(encoded, `"k" holds a number that is not finite`)
			}
			key = append(key, text.NumberSortValue(entry.number))
		case jsonString:
			if text.ExceedsCodePoints(entry.text, text.SortValueMaxCodePoints) {
				return nil, invalidCursor(encoded, `"k" holds an oversized sort value`)
			}
			key = append(key, text.StringSortValue(entry.text))
		default:
			return nil, invalidCursor(encoded, `"k" accepts a string, a finite number, a boolean, or null`)
		}
	}
	return key, nil
}

func parseCursorPayload(encoded string) (map[string]jsonValue, error) {
	if len(encoded) > maxCursorLength && text.UTF16Length(encoded) > maxCursorLength {
		return nil, invalidCursor(encoded, "the cursor is too long")
	}
	payload := text.DecodeUTF8(decodeLenientBase64(text.EncodeUTF16(encoded)))
	parsed, valid := parseJSON(payload)
	if !valid {
		return nil, invalidCursor(encoded, "invalid JSON")
	}
	if parsed.kind != jsonObject {
		return nil, invalidCursor(encoded, "expected an object")
	}
	return parsed.members, nil
}

func requireCursorVersion(members map[string]jsonValue, encoded string) error {
	version, present := members["v"]
	if present && version.kind == jsonNumber && version.number == cursorVersion {
		return nil
	}
	shown := []byte("undefined")
	if present {
		shown = appendJavaScriptString(shown[:0], version)
	}
	return invalidCursor(encoded, "unsupported cursor version "+string(shown))
}

func DecodePageCursor(encoded string) (PageCursor, error) {
	members, err := parseCursorPayload(encoded)
	if err != nil {
		return PageCursor{}, err
	}
	if err := requireCursorVersion(members, encoded); err != nil {
		return PageCursor{}, err
	}
	binding, hasBinding := members["q"]
	if !hasBinding || binding.kind != jsonString || !isBindingText(binding.text) {
		return PageCursor{}, invalidCursor(encoded, `"q" must be 8 lowercase hex digits`)
	}
	anchor, hasAnchor := members["a"]
	if !hasAnchor || anchor.kind != jsonString || anchor.text == "" {
		return PageCursor{}, invalidCursor(encoded, `"a" must be a non-empty string`)
	}
	if text.ExceedsCodePoints(anchor.text, maxCursorAnchorCodePoints) {
		return PageCursor{}, invalidCursor(encoded, `"a" is too long to be a document id`)
	}
	score, hasScore := members["s"]
	if hasScore && (score.kind != jsonNumber || !isFinite(score.number)) {
		return PageCursor{}, invalidCursor(encoded, `"s" must be a finite number`)
	}
	sortKeyValue, hasSortKey := members["k"]
	if hasScore && hasSortKey {
		return PageCursor{}, invalidCursor(encoded, `a cursor carries "s" or "k", never both`)
	}
	depth, hasDepth := members["d"]
	if hasDepth && (depth.kind != jsonNumber || !isSafeInteger(depth.number) || depth.number < 1) {
		return PageCursor{}, invalidCursor(encoded, `"d" must be a positive integer`)
	}
	decoded := PageCursor{Anchor: anchor.text, Binding: binding.text}
	if hasSortKey {
		if decoded.SortKey, err = decodeSortKey(sortKeyValue, encoded); err != nil {
			return PageCursor{}, err
		}
	}
	signature, hasSignature := members["o"]
	if hasSignature && signature.kind != jsonString {
		return PageCursor{}, invalidCursor(encoded, `"o" must be a string`)
	}
	if hasSortKey != hasSignature {
		return PageCursor{}, invalidCursor(encoded, `"k" and "o" have to arrive together`)
	}
	if hasSignature {
		decoded.SortSignature = model.Some(signature.text)
	}
	if hasScore {
		decoded.Score = model.Some(score.number)
	}
	if hasDepth {
		decoded.Depth = int(depth.number)
	}
	return decoded, nil
}

func RequireMatchingCursor(cursor PageCursor, encoded string, signature model.Optional[string], scoreAnchored bool, binding string) error {
	if cursor.Binding != binding {
		return invalidCursor(encoded, "the cursor belongs to a different query")
	}
	cursorSignature, cursorSorted := cursor.SortSignature.Get()
	if requestSignature, requestSorted := signature.Get(); requestSorted {
		if !cursorSorted || cursorSignature != requestSignature {
			return invalidCursor(encoded, "the cursor belongs to a different sort order")
		}
		return nil
	}
	if cursorSorted {
		return invalidCursor(encoded, "the cursor belongs to a sorted request")
	}
	if scoreAnchored && !cursor.Score.IsSet() {
		return invalidCursor(encoded, "the cursor carries no score to seek from")
	}
	if !scoreAnchored && cursor.Score.IsSet() {
		return invalidCursor(encoded, "the cursor belongs to a search rather than a listing")
	}
	return nil
}

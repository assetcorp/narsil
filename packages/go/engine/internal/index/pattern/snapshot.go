package pattern

import (
	"math"
	"strconv"
	"unicode/utf8"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type SnapshotRun struct {
	Key       string
	Positions []uint32
}

type Snapshot struct {
	DocIDs []string
	Runs   []SnapshotRun
}

type EncodedSnapshotRun struct {
	Key       string
	Positions any
}

type ArraysSource interface {
	Arrays(field string) Arrays
}

func loadFailed(field, problem string) error {
	return narsilerr.New(narsilerr.CodePersistenceLoadFailed,
		`The pattern index of field "`+field+`" in this partition is corrupt: `+problem, map[string]any{"field": field})
}

func runKeyText(runs []uint32, at int) string {
	key := make([]byte, 0, RunCodePoints*utf8.UTFMax)
	for offset := range RunCodePoints {
		key = utf8.AppendRune(key, rune(runs[at+offset]))
	}
	return string(key)
}

func SnapshotOf(field string, index ArraysSource, toExternal func(ordinal uint32) (string, bool)) Snapshot {
	arrays := index.Arrays(field)
	positionOf := make(map[uint32]uint32, len(arrays.Documents))
	snapshot := Snapshot{DocIDs: make([]string, 0, len(arrays.Documents))}
	for _, ordinal := range arrays.Documents {
		externalID, known := toExternal(ordinal)
		if !known {
			continue
		}
		positionOf[ordinal] = uint32(len(snapshot.DocIDs))
		snapshot.DocIDs = append(snapshot.DocIDs, externalID)
	}
	for run := range arrays.RunCount() {
		var positions []uint32
		for _, ordinal := range arrays.postingsAt(run) {
			if position, known := positionOf[ordinal]; known {
				positions = append(positions, position)
			}
		}
		if len(positions) == 0 {
			continue
		}
		snapshot.Runs = append(snapshot.Runs, SnapshotRun{Key: runKeyText(arrays.Runs, run*RunCodePoints), Positions: positions})
	}
	return snapshot
}

func appendKeyCodePoints(field, key string, runs []uint32) ([]uint32, error) {
	count := 0
	var codePoints [RunCodePoints]uint32
	for at := 0; at < len(key); {
		codePoint, size := text.NextCodePoint(key, at)
		if count < RunCodePoints {
			codePoints[count] = uint32(codePoint)
		}
		count++
		at += size
	}
	if count != RunCodePoints {
		return nil, loadFailed(field, `the key "`+key+`" holds `+strconv.Itoa(count)+
			" code points, while each key must hold "+strconv.Itoa(RunCodePoints))
	}
	return append(runs, codePoints[:]...), nil
}

func shownPosition(position any) string {
	switch typed := position.(type) {
	case nil:
		return "null"
	case bool:
		return strconv.FormatBool(typed)
	case string:
		return typed
	case float64:
		return text.FormatNumber(typed)
	case float32:
		return text.FormatNumber(float64(typed))
	}
	if whole, isWhole := wholeNumber(position); isWhole {
		return strconv.FormatInt(whole, 10)
	}
	return "[object Object]"
}

func wholeNumber(position any) (int64, bool) {
	switch typed := position.(type) {
	case int:
		return int64(typed), true
	case int8:
		return int64(typed), true
	case int16:
		return int64(typed), true
	case int32:
		return int64(typed), true
	case int64:
		return typed, true
	case uint8:
		return int64(typed), true
	case uint16:
		return int64(typed), true
	case uint32:
		return int64(typed), true
	case uint64:
		if typed <= math.MaxInt64 {
			return int64(typed), true
		}
	case float64:
		if typed == math.Trunc(typed) && !math.IsInf(typed, 0) && math.Abs(typed) < 1<<62 {
			return int64(typed), true
		}
	case float32:
		widened := float64(typed)
		if widened == math.Trunc(widened) && !math.IsInf(widened, 0) && math.Abs(widened) < 1<<62 {
			return int64(widened), true
		}
	}
	return 0, false
}

func positionList(list any) ([]any, bool) {
	switch typed := list.(type) {
	case []any:
		return typed, true
	case []uint32:
		converted := make([]any, len(typed))
		for at, position := range typed {
			converted[at] = position
		}
		return converted, true
	}
	return nil, false
}

func requirePositions(field, key string, list any, documentCount int, postings []uint32) ([]uint32, error) {
	positions, isList := positionList(list)
	if !isList {
		return nil, loadFailed(field, `the run "`+key+`" must map to a list of positions`)
	}
	previous := int64(-1)
	for _, raw := range positions {
		position, isWhole := wholeNumber(raw)
		if !isWhole || position < 0 || position >= int64(documentCount) {
			return nil, loadFailed(field, `the run "`+key+`" names position `+shownPosition(raw)+" outside its document list")
		}
		if position <= previous {
			return nil, loadFailed(field, `the positions of the run "`+key+`" are out of ascending order`)
		}
		previous = position
		postings = append(postings, uint32(position))
	}
	return postings, nil
}

func DecodeSnapshot(field string, docIDs []string, runs []EncodedSnapshotRun) (Arrays, error) {
	seen := make(map[string]struct{}, len(docIDs))
	for _, docID := range docIDs {
		if _, held := seen[docID]; held {
			return Arrays{}, loadFailed(field, `the document list names "`+docID+`" twice`)
		}
		seen[docID] = struct{}{}
	}
	decoded := Arrays{Field: field, Runs: []uint32{}, Offsets: []uint32{0}, Postings: []uint32{}}
	var err error
	for _, run := range runs {
		if decoded.Runs, err = appendKeyCodePoints(field, run.Key, decoded.Runs); err != nil {
			return Arrays{}, err
		}
		if decoded.Postings, err = requirePositions(field, run.Key, run.Positions, len(docIDs), decoded.Postings); err != nil {
			return Arrays{}, err
		}
		decoded.Offsets = append(decoded.Offsets, uint32(len(decoded.Postings)))
	}
	decoded.Documents = make([]uint32, len(docIDs))
	for position := range decoded.Documents {
		decoded.Documents[position] = uint32(position)
	}
	return decoded, nil
}

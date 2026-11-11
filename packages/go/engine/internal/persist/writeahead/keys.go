package writeahead

import (
	"slices"
	"strconv"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/storage"
)

func Prefix(indexName string, partitionID uint32) string {
	return indexName + "/wal/" + strconv.FormatUint(uint64(partitionID), 10) + "/"
}

func MarkerKey(indexName string, partitionID uint32) string {
	return Prefix(indexName, partitionID) + "commit"
}

func PreparedKey(indexName string, partitionID uint32) string {
	return Prefix(indexName, partitionID) + "next"
}

func SegmentKey(indexName string, partitionID uint32, startSeqNo uint64) string {
	digits := strconv.FormatUint(startSeqNo, 10)
	if len(digits) < segmentNameDigits {
		digits = strings.Repeat("0", segmentNameDigits-len(digits)) + digits
	}
	return Prefix(indexName, partitionID) + digits
}

func segmentStart(key string, prefix string) (uint64, bool) {
	if !strings.HasPrefix(key, prefix) {
		return 0, false
	}
	tail := key[len(prefix):]
	if len(tail) != segmentNameDigits {
		return 0, false
	}
	for _, character := range []byte(tail) {
		if character < '0' || character > '9' {
			return 0, false
		}
	}
	value, err := strconv.ParseUint(tail, 10, 64)
	if err != nil || value > form.MaxSafeInteger {
		return 0, false
	}
	return value, true
}

type SegmentRef struct {
	Key        string
	StartSeqNo uint64
}

func listSegments(directory *storage.Directory, indexName string, partitionID uint32) ([]SegmentRef, error) {
	prefix := Prefix(indexName, partitionID)
	keys, err := directory.List(prefix)
	if err != nil {
		return nil, err
	}
	var segments []SegmentRef
	for _, key := range keys {
		if start, ok := segmentStart(key, prefix); ok {
			segments = append(segments, SegmentRef{Key: key, StartSeqNo: start})
		}
	}
	slices.SortFunc(segments, func(left, right SegmentRef) int {
		switch {
		case left.StartSeqNo < right.StartSeqNo:
			return -1
		case left.StartSeqNo > right.StartSeqNo:
			return 1
		}
		return 0
	})
	return segments, nil
}

func partitionOfKey(key string, walRoot string) (uint64, bool) {
	tail, found := strings.CutPrefix(key, walRoot)
	if !found {
		return 0, false
	}
	separator := strings.IndexByte(tail, '/')
	if separator <= 0 {
		return 0, false
	}
	value, err := strconv.ParseUint(tail[:separator], 10, 64)
	return value, err == nil && value <= form.MaxSafeInteger
}

func RemoveBeyondCount(directory *storage.Directory, indexName string, partitionCount int) error {
	walRoot := indexName + "/wal/"
	keys, err := directory.List(walRoot)
	if err != nil {
		return err
	}
	for _, key := range keys {
		partition, ok := partitionOfKey(key, walRoot)
		if !ok || partition < uint64(partitionCount) {
			continue
		}
		if err := directory.Remove(key); err != nil {
			return err
		}
	}
	return nil
}

func RemovePartitionLog(directory *storage.Directory, indexName string, partitionID uint32) error {
	keys, err := directory.List(Prefix(indexName, partitionID))
	if err != nil {
		return err
	}
	for _, key := range keys {
		if err := directory.Remove(key); err != nil {
			return err
		}
	}
	return nil
}

func malformedSegmentKey(key string) error {
	return narsilerr.New(narsilerr.CodePersistenceLoadFailed, `Malformed WAL segment key: "`+key+`"`,
		map[string]any{"key": key})
}

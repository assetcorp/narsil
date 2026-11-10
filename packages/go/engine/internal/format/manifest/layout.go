package manifest

import (
	"strconv"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const (
	segmentIDWidth          = 16
	fieldPathBase           = 36
	segmentsMarker          = "/segments/"
	indexNameOfEmptyArchive = "archive"
)

func ManifestKey(indexName string) string {
	return indexName + "/manifest"
}

func SnapshotBundleKey(indexName string) string {
	return indexName + "/snapshot"
}

func SegmentsPrefix(indexName string) string {
	return indexName + segmentsMarker
}

func SegmentPrefix(indexName string, partitionID uint32) string {
	return SegmentsPrefix(indexName) + strconv.FormatUint(uint64(partitionID), 10) + "/"
}

func formatID(id uint64) string {
	digits := strconv.FormatUint(id, 10)
	if len(digits) >= segmentIDWidth {
		return digits
	}
	return strings.Repeat("0", segmentIDWidth-len(digits)) + digits
}

func SegmentKey(indexName string, partitionID uint32, segmentID uint64) string {
	return SegmentPrefix(indexName, partitionID) + "s" + formatID(segmentID)
}

func validFieldPath(fieldPath string) bool {
	if fieldPath == "" {
		return false
	}
	for index := 0; index < len(fieldPath); index++ {
		character := fieldPath[index]
		switch {
		case character >= 'A' && character <= 'Z', character >= 'a' && character <= 'z',
			character >= '0' && character <= '9', character == '_', character == '.':
		default:
			return false
		}
	}
	return true
}

func EncodeFieldPath(fieldPath string) (string, error) {
	if !validFieldPath(fieldPath) {
		return "", narsilerr.New(narsilerr.CodePersistenceSaveFailed,
			"Vector field path \""+fieldPath+"\" contains characters that cannot be encoded in a segment key",
			map[string]any{"fieldPath": fieldPath})
	}
	fingerprint := strconv.FormatUint(uint64(codec.FNV1aString(fieldPath)), fieldPathBase)
	return strings.ReplaceAll(fieldPath, ".", "_") + "-" + fingerprint, nil
}

func VectorFileKey(indexName string, fieldPath string, fileID uint64) (string, error) {
	encoded, err := EncodeFieldPath(fieldPath)
	if err != nil {
		return "", err
	}
	return SegmentsPrefix(indexName) + "vec-" + encoded + "-f" + formatID(fileID), nil
}

func requireGeneration(generation uint64) error {
	if generation > 0 && generation <= MaxSegmentID {
		return nil
	}
	return narsilerr.New(narsilerr.CodePersistenceSaveFailed,
		"Vector graph generation "+strconv.FormatUint(generation, 10)+" must be a positive integer",
		map[string]any{"generation": generation})
}

func EarlierGraphKey(indexName string, fieldPath string, generation uint64) (string, error) {
	if err := requireGeneration(generation); err != nil {
		return "", err
	}
	encoded, err := EncodeFieldPath(fieldPath)
	if err != nil {
		return "", err
	}
	return SegmentsPrefix(indexName) + "vec-" + encoded + "-graph-g" + strconv.FormatUint(generation, 10), nil
}

func GraphPartKey(indexName string, fieldPath string, generation uint64, part uint64) (string, error) {
	base, err := EarlierGraphKey(indexName, fieldPath, generation)
	if err != nil {
		return "", err
	}
	return base + "-p" + formatID(part), nil
}

func SourceIndexName(keys []string) (string, error) {
	if len(keys) == 0 {
		return indexNameOfEmptyArchive, nil
	}
	first := keys[0]
	at := strings.Index(first, segmentsMarker)
	if at <= 0 {
		return "", narsilerr.New(narsilerr.CodePersistenceLoadFailed,
			"The snapshot archive is invalid: the manifest lists the key \""+first+"\" outside any index",
			map[string]any{"key": first})
	}
	return first[:at], nil
}

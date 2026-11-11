package persist

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strconv"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/storage"
)

const (
	publishedSnapshotEnvelopeVersion = 1
	publishedSnapshotWhat            = "published snapshot"
	syncKeyNumberDigits              = 16
)

var publishedSnapshotKind = envelope.Kind{FormatVersion: publishedSnapshotEnvelopeVersion, What: publishedSnapshotWhat}

type PublishedSnapshot struct {
	Config        []byte
	ManifestBytes []byte
	Manifest      manifest.Manifest
	EntityTag     string
	Keys          map[string]struct{}
}

type historySegment struct {
	key        string
	partition  uint32
	startSeqNo uint64
	movedAtMs  uint64
}

func syncDirectoryPrefix(indexName string) string {
	return indexName + "/sync/"
}

func publishedSnapshotKey(indexName string) string {
	return syncDirectoryPrefix(indexName) + "published"
}

func historyRoot(indexName string) string {
	return indexName + "/history/"
}

func historyPrefix(indexName string, partitionID uint32) string {
	return historyRoot(indexName) + strconv.FormatUint(uint64(partitionID), 10) + "/"
}

func syncKeyNumber(value uint64) string {
	digits := strconv.FormatUint(value, 10)
	if len(digits) < syncKeyNumberDigits {
		digits = strings.Repeat("0", syncKeyNumberDigits-len(digits)) + digits
	}
	return digits
}

func historyKey(indexName string, partitionID uint32, startSeqNo uint64, movedAtMs uint64) string {
	return historyPrefix(indexName, partitionID) + syncKeyNumber(startSeqNo) + "-" + syncKeyNumber(movedAtMs)
}

func syncKeyDigits(text string) (uint64, bool) {
	if len(text) != syncKeyNumberDigits {
		return 0, false
	}
	for _, character := range []byte(text) {
		if character < '0' || character > '9' {
			return 0, false
		}
	}
	value, err := strconv.ParseUint(text, 10, 64)
	if err != nil || value > form.MaxSafeInteger {
		return 0, false
	}
	return value, true
}

func parseHistoryKey(indexName string, key string) (historySegment, bool) {
	root := historyRoot(indexName)
	if !strings.HasPrefix(key, root) {
		return historySegment{}, false
	}
	partitionText, tail, found := strings.Cut(key[len(root):], "/")
	if !found || partitionText == "" {
		return historySegment{}, false
	}
	for _, character := range []byte(partitionText) {
		if character < '0' || character > '9' {
			return historySegment{}, false
		}
	}
	partitionID, err := strconv.ParseUint(partitionText, 10, 32)
	if err != nil {
		return historySegment{}, false
	}
	startText, movedText, found := strings.Cut(tail, "-")
	if !found {
		return historySegment{}, false
	}
	start, startValid := syncKeyDigits(startText)
	moved, movedValid := syncKeyDigits(movedText)
	if !startValid || !movedValid {
		return historySegment{}, false
	}
	return historySegment{key: key, partition: uint32(partitionID), startSeqNo: start, movedAtMs: moved}, true
}

func listHistory(directory *storage.Directory, indexName string) ([]historySegment, error) {
	keys, err := directory.List(historyRoot(indexName))
	if err != nil {
		return nil, err
	}
	segments := make([]historySegment, 0, len(keys))
	for _, key := range keys {
		if segment, ok := parseHistoryKey(indexName, key); ok {
			segments = append(segments, segment)
		}
	}
	sort.Slice(segments, func(left, right int) bool {
		if segments[left].partition != segments[right].partition {
			return segments[left].partition < segments[right].partition
		}
		return segments[left].startSeqNo < segments[right].startSeqNo
	})
	return segments, nil
}

func removeHistory(directory *storage.Directory, indexName string) error {
	segments, err := listHistory(directory, indexName)
	if err != nil {
		return err
	}
	for _, segment := range segments {
		if err := directory.Remove(segment.key); err != nil {
			return err
		}
	}
	return nil
}

func publishedLoadFailed(indexName string, message string) error {
	return narsilerr.New(narsilerr.CodePersistenceLoadFailed,
		`The published snapshot of index "`+indexName+`" `+message, map[string]any{"indexName": indexName})
}

func publishedFrom(indexName string, payload []byte, config []byte, manifestBytes []byte) (*PublishedSnapshot, error) {
	opened, err := manifest.Open(manifestBytes)
	if err != nil {
		return nil, err
	}
	if manifest.IsEarlier(opened.Payload) {
		return nil, publishedLoadFailed(indexName, "holds a manifest of an earlier layout")
	}
	decoded, err := manifest.FromPayload(opened.Payload, indexName)
	if err != nil {
		return nil, err
	}
	keys := map[string]struct{}{}
	for _, key := range decoded.ListedKeys() {
		keys[key] = struct{}{}
	}
	digest := sha256.Sum256(payload)
	return &PublishedSnapshot{Config: config, ManifestBytes: manifestBytes, Manifest: decoded,
		EntityTag: hex.EncodeToString(digest[:]), Keys: keys}, nil
}

func publishedPayload(config []byte, manifestBytes []byte) []byte {
	payload := codec.AppendMapHeader(nil, 2)
	payload = codec.AppendString(payload, "config")
	payload = codec.AppendBinary(payload, config)
	payload = codec.AppendString(payload, "manifest")
	return codec.AppendBinary(payload, manifestBytes)
}

func writePublishedSnapshot(directory *storage.Directory, indexName string, config []byte,
	manifestBytes []byte) (*PublishedSnapshot, error) {
	payload := publishedPayload(config, manifestBytes)
	packed, err := envelope.Pack(payload, envelope.PackOptions{FormatVersion: publishedSnapshotEnvelopeVersion,
		What: publishedSnapshotWhat, Checksum: true})
	if err != nil {
		return nil, err
	}
	published, err := publishedFrom(indexName, payload, config, manifestBytes)
	if err != nil {
		return nil, err
	}
	if err := directory.AtomicWrite(publishedSnapshotKey(indexName), packed); err != nil {
		return nil, err
	}
	return published, nil
}

func readPublishedSnapshot(directory *storage.Directory, indexName string) (*PublishedSnapshot, error) {
	data, err := directory.Read(publishedSnapshotKey(indexName))
	if err != nil || data == nil {
		return nil, err
	}
	opened, err := envelope.OpenChecksummed(data, publishedSnapshotKind)
	if err != nil {
		return nil, err
	}
	decoded, err := codec.Unmarshal(opened.Payload, codec.DecodeOptions{ErrorCode: narsilerr.CodePersistenceLoadFailed})
	if err != nil {
		return nil, err
	}
	record, isMap := decoded.(map[string]any)
	config, configBytes := record["config"].([]byte)
	listed, manifestBytes := record["manifest"].([]byte)
	if !isMap || !configBytes || !manifestBytes {
		return nil, publishedLoadFailed(indexName, "lacks its configuration or its manifest")
	}
	return publishedFrom(indexName, opened.Payload, config, listed)
}

package suggestions

import (
	"crypto/sha256"
	"sort"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	is "github.com/assetcorp/narsil/packages/go/engine/internal/format/indexsettings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

const buildRecordWhat = "query suggestions build record"

type BuildRecord struct {
	BuildID       string
	Trigger       string
	Status        string
	StartedAt     uint64
	EndedAt       uint64
	HasEndedAt    bool
	Published     uint64
	Removed       uint64
	Discarded     uint64
	SourcesDigest [SourcesDigestBytes]byte
	ErrorCode     string
}

type MergedSource struct {
	NodeID  string
	Key     string
	SavedAt uint64
}

func SourcesDigestOf(sources []MergedSource) [SourcesDigestBytes]byte {
	sorted := append([]MergedSource(nil), sources...)
	sort.SliceStable(sorted, func(left, right int) bool {
		if order := text.CompareCodePoints(sorted[left].NodeID, sorted[right].NodeID); order != 0 {
			return order < 0
		}
		return text.CompareCodePoints(sorted[left].Key, sorted[right].Key) < 0
	})
	out := &writer{}
	out.arrayHeader(len(sorted))
	for _, source := range sorted {
		out.arrayHeader(3)
		out.text(source.NodeID)
		out.text(source.Key)
		out.uint(source.SavedAt)
	}
	return sha256.Sum256(out.bytes)
}

func (record BuildRecord) wire() codec.OrderedMap {
	entries := codec.OrderedMap{
		{Key: "buildId", Value: record.BuildID},
		{Key: "trigger", Value: record.Trigger},
		{Key: "status", Value: record.Status},
		{Key: "startedAt", Value: float64(record.StartedAt)},
	}
	if record.HasEndedAt {
		entries = append(entries, codec.MapEntry{Key: "endedAt", Value: float64(record.EndedAt)})
	}
	entries = append(entries,
		codec.MapEntry{Key: "published", Value: float64(record.Published)},
		codec.MapEntry{Key: "removed", Value: float64(record.Removed)},
		codec.MapEntry{Key: "discarded", Value: float64(record.Discarded)},
		codec.MapEntry{Key: "sourcesDigest", Value: record.SourcesDigest[:]},
	)
	if record.ErrorCode != "" {
		entries = append(entries, codec.MapEntry{Key: "errorCode", Value: record.ErrorCode})
	}
	return entries
}

func EncodeBuildRecord(record BuildRecord) ([]byte, error) {
	payload, err := codec.Marshal(record.wire(), codec.EncodeOptions{})
	if err != nil {
		return nil, err
	}
	return envelope.Pack(payload, envelope.PackOptions{FormatVersion: buildRecordFormatVersion, What: buildRecordWhat,
		Checksum: true})
}

var (
	buildTriggers = map[string]bool{"schedule": true, "missed": true, "caller": true}
	buildStatuses = map[string]bool{"running": true, "completed": true, "failed": true, "skipped": true}
)

func countOf(value any) (uint64, bool) {
	number, whole := is.AsSafeInteger(value)
	if !whole || number < 0 {
		return 0, false
	}
	return uint64(number), true
}

func DecodeBuildRecord(data []byte) (BuildRecord, bool) {
	opened, err := envelope.OpenChecksummed(data, envelope.Kind{FormatVersion: buildRecordFormatVersion,
		What: buildRecordWhat})
	if err != nil {
		return BuildRecord{}, false
	}
	raw, err := codec.Unmarshal(opened.Payload, codec.DecodeOptions{})
	if err != nil {
		return BuildRecord{}, false
	}
	value, isMap := is.AsMap(raw)
	if !isMap {
		return BuildRecord{}, false
	}
	var record BuildRecord
	var ok [4]bool
	record.BuildID, ok[0] = value["buildId"].(string)
	record.Trigger, ok[1] = value["trigger"].(string)
	record.Status, ok[2] = value["status"].(string)
	if !ok[0] || !ok[1] || !ok[2] || !buildTriggers[record.Trigger] || !buildStatuses[record.Status] {
		return BuildRecord{}, false
	}
	counts := []*uint64{&record.StartedAt, &record.Published, &record.Removed, &record.Discarded}
	for index, key := range []string{"startedAt", "published", "removed", "discarded"} {
		if *counts[index], ok[3] = countOf(value[key]); !ok[3] {
			return BuildRecord{}, false
		}
	}
	if ended, present := value["endedAt"]; present {
		if record.EndedAt, ok[3] = countOf(ended); !ok[3] {
			return BuildRecord{}, false
		}
		record.HasEndedAt = true
	}
	if code, present := value["errorCode"]; present {
		if record.ErrorCode, ok[3] = code.(string); !ok[3] {
			return BuildRecord{}, false
		}
	}
	digest, isBytes := value["sourcesDigest"].([]byte)
	if !isBytes || len(digest) != SourcesDigestBytes {
		return BuildRecord{}, false
	}
	copy(record.SourcesDigest[:], digest)
	return record, true
}

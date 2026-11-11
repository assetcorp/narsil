package backup

import (
	"math"
	"strconv"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	is "github.com/assetcorp/narsil/packages/go/engine/internal/format/indexsettings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const (
	FormatVersion = 1
	SyncTaker     = "sync"
	sha256Length  = 64
)

type StoredFile struct {
	SHA256 string
	Bytes  uint64
}

type ListedFile struct {
	Key string
	StoredFile
}

type Partition struct {
	PartitionID uint32
	LastSeqNo   uint64
	Manifest    StoredFile
	Files       []ListedFile
}

type Constraints struct {
	ZoneAwareness    bool
	ZoneAttribute    string
	MaxShardsPerNode model.Optional[uint64]
}

type Manifest struct {
	Name              string
	ClusterUUID       string
	IndexName         string
	StartedAt         uint64
	CompletedAt       uint64
	PartitionCount    uint32
	SyncEpoch         model.Optional[string]
	TakenBy           model.Optional[string]
	ReplicationFactor uint32
	Constraints       Constraints
	Config            StoredFile
	QueryHistory      model.Optional[[]StoredFile]
	Partitions        []Partition
}

func Damaged(backupName string, reason string) error {
	return narsilerr.New(narsilerr.CodeBackupDamaged, "The manifest of backup '"+backupName+"' "+reason,
		map[string]any{"backupName": backupName})
}

func isSHA256Hex(value any) bool {
	digest, ok := value.(string)
	if !ok || len(digest) != sha256Length {
		return false
	}
	for index := 0; index < len(digest); index++ {
		character := digest[index]
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

func isPathSegment(segment string) bool {
	if segment == "" {
		return false
	}
	for index := 0; index < len(segment); index++ {
		character := segment[index]
		alphanumeric := (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') ||
			(character >= '0' && character <= '9')
		if !alphanumeric && (index == 0 || (character != '.' && character != '_' && character != '-')) {
			return false
		}
	}
	return true
}

func IsSafeFileKey(key string) bool {
	if len(key) > MaxFilePathLength {
		return false
	}
	for _, segment := range strings.Split(key, "/") {
		if !isPathSegment(segment) {
			return false
		}
	}
	return true
}

func readStoredFile(value any, backupName string) (StoredFile, error) {
	record, ok := is.AsMap(value)
	if !ok || !isSHA256Hex(record["sha256"]) {
		return StoredFile{}, Damaged(backupName, "lists a file without a valid SHA-256 digest and length")
	}
	bytes, valid := is.AsCount(record["bytes"], envelope.MaxFileBytes)
	if !valid {
		return StoredFile{}, Damaged(backupName, "lists a file without a valid SHA-256 digest and length")
	}
	digest, _ := record["sha256"].(string)
	return StoredFile{SHA256: digest, Bytes: bytes}, nil
}

func readPartition(value any, backupName string, partitionCount uint32) (Partition, error) {
	record, ok := is.AsMap(value)
	malformed := Damaged(backupName, "holds a malformed partition entry")
	if !ok {
		return Partition{}, malformed
	}
	partitionID, validID := is.AsCount(record["partitionId"], math.MaxUint32)
	lastSeqNo, validSeqNo := is.AsCount(record["lastSeqNo"], form.MaxSafeInteger)
	files, isList := record["files"].([]any)
	if !validID || partitionID >= uint64(partitionCount) || !validSeqNo || !isList || len(files) > MaxFilesPerPartition {
		return Partition{}, malformed
	}
	listed := make([]ListedFile, len(files))
	seen := make(map[string]bool, len(files))
	for index, rawFile := range files {
		stored, err := readStoredFile(rawFile, backupName)
		if err != nil {
			return Partition{}, err
		}
		fileRecord, _ := is.AsMap(rawFile)
		key, isText := fileRecord["key"].(string)
		if !isText || !IsSafeFileKey(key) {
			return Partition{}, Damaged(backupName, "lists a file under an unsafe key")
		}
		if seen[key] {
			return Partition{}, Damaged(backupName, "lists one key twice in a partition")
		}
		seen[key] = true
		listed[index] = ListedFile{Key: key, StoredFile: stored}
	}
	manifest, err := readStoredFile(record["manifest"], backupName)
	if err != nil {
		return Partition{}, err
	}
	return Partition{PartitionID: uint32(partitionID), LastSeqNo: lastSeqNo, Manifest: manifest, Files: listed}, nil
}

func readConstraints(value any) (Constraints, bool) {
	record, ok := is.AsMap(value)
	if !ok {
		return Constraints{}, false
	}
	awareness, isFlag := record["zoneAwareness"].(bool)
	attribute, isText := record["zoneAttribute"].(string)
	if !isFlag || !isText || attribute == "" {
		return Constraints{}, false
	}
	constraints := Constraints{ZoneAwareness: awareness, ZoneAttribute: attribute}
	rawMax, has := record["maxShardsPerNode"]
	if !has {
		return Constraints{}, false
	}
	if rawMax != nil {
		maximum, positive := is.AsPositive(rawMax, form.MaxSafeInteger)
		if !positive {
			return Constraints{}, false
		}
		constraints.MaxShardsPerNode = model.Some(maximum)
	}
	return constraints, true
}

func readQueryHistory(record map[string]any, backupName string) (model.Optional[[]StoredFile], error) {
	raw, has := record["queryHistory"]
	if !has {
		return model.Optional[[]StoredFile]{}, nil
	}
	list, ok := raw.([]any)
	if !ok || len(list) > MaxHistoryFiles {
		return model.Optional[[]StoredFile]{}, Damaged(backupName, "holds a malformed query history list")
	}
	files := make([]StoredFile, len(list))
	for index, entry := range list {
		stored, err := readStoredFile(entry, backupName)
		if err != nil {
			return model.Optional[[]StoredFile]{}, err
		}
		files[index] = stored
	}
	for _, stored := range files {
		if stored.Bytes > MaxHistoryFileBytes {
			return model.Optional[[]StoredFile]{}, Damaged(backupName, "lists a query history file longer than "+
				strconv.Itoa(MaxHistoryFileBytes)+" bytes")
		}
	}
	return model.Some(files), nil
}

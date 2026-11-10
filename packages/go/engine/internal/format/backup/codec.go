package backup

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	is "github.com/assetcorp/narsil/packages/go/engine/internal/format/indexsettings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/metadata"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

func readHeader(record map[string]any, backupName string) (Manifest, bool) {
	name, isName := record["name"].(string)
	clusterUUID, isCluster := record["clusterUuid"].(string)
	indexName, isIndex := record["indexName"].(string)
	startedAt, validStart := is.AsCount(record["startedAt"], form.MaxSafeInteger)
	completedAt, validEnd := is.AsCount(record["completedAt"], form.MaxSafeInteger)
	partitionCount, validCount := is.AsPositive(record["partitionCount"], MaxPartitionCount)
	replication, validReplication := is.AsCount(record["replicationFactor"], MaxReplicationFactor)
	partitions, isList := record["partitions"].([]any)
	if !isName || name != backupName || !isCluster || !isIndex || !validStart || !validEnd || !validCount ||
		!validReplication || !isList || uint64(len(partitions)) != partitionCount {
		return Manifest{}, false
	}
	manifest := Manifest{
		Name: name, ClusterUUID: clusterUUID, IndexName: indexName, StartedAt: startedAt, CompletedAt: completedAt,
		PartitionCount: uint32(partitionCount), ReplicationFactor: uint32(replication),
	}
	if raw, has := record["syncEpoch"]; has {
		epoch, isText := raw.(string)
		if !isText || !metadata.IsSyncEpoch(epoch) {
			return Manifest{}, false
		}
		manifest.SyncEpoch = model.Some(epoch)
	}
	if raw, has := record["takenBy"]; has {
		taker, isText := raw.(string)
		if !isText {
			return Manifest{}, false
		}
		manifest.TakenBy = model.Some(taker)
	}
	return manifest, true
}

func messageOf(err error) string {
	if problem, ok := narsilerr.As(err); ok {
		return problem.Message
	}
	return err.Error()
}

func Decode(value any, backupName string) (Manifest, error) {
	record, ok := is.AsMap(value)
	if !ok {
		return Manifest{}, Damaged(backupName, "holds a malformed header")
	}
	manifest, valid := readHeader(record, backupName)
	if !valid {
		return Manifest{}, Damaged(backupName, "holds a malformed header")
	}
	constraints, validConstraints := readConstraints(record["constraints"])
	if !validConstraints {
		return Manifest{}, Damaged(backupName, "holds malformed allocation constraints")
	}
	manifest.Constraints = constraints
	partitions, _ := record["partitions"].([]any)
	manifest.Partitions = make([]Partition, len(partitions))
	for index, entry := range partitions {
		partition, err := readPartition(entry, backupName, manifest.PartitionCount)
		if err != nil {
			return Manifest{}, err
		}
		manifest.Partitions[index] = partition
	}
	for position, partition := range manifest.Partitions {
		if uint64(partition.PartitionID) != uint64(position) {
			return Manifest{}, Damaged(backupName, "lists its partitions out of partitionId order")
		}
	}
	config, err := readStoredFile(record["config"], backupName)
	if err != nil {
		return Manifest{}, err
	}
	manifest.Config = config
	if manifest.QueryHistory, err = readQueryHistory(record, backupName); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

func storedValue(stored StoredFile) codec.OrderedMap {
	return codec.OrderedMap{{Key: "sha256", Value: stored.SHA256}, {Key: "bytes", Value: float64(stored.Bytes)}}
}

func partitionValue(partition Partition) codec.OrderedMap {
	files := make([]any, len(partition.Files))
	for index, file := range partition.Files {
		files[index] = append(codec.OrderedMap{{Key: "key", Value: file.Key}}, storedValue(file.StoredFile)...)
	}
	return codec.OrderedMap{
		{Key: "partitionId", Value: float64(partition.PartitionID)},
		{Key: "lastSeqNo", Value: float64(partition.LastSeqNo)},
		{Key: "manifest", Value: storedValue(partition.Manifest)},
		{Key: "files", Value: files},
	}
}

func (manifest Manifest) Value() codec.OrderedMap {
	entries := codec.OrderedMap{
		{Key: "name", Value: manifest.Name},
		{Key: "clusterUuid", Value: manifest.ClusterUUID},
		{Key: "indexName", Value: manifest.IndexName},
		{Key: "startedAt", Value: float64(manifest.StartedAt)},
		{Key: "completedAt", Value: float64(manifest.CompletedAt)},
		{Key: "partitionCount", Value: float64(manifest.PartitionCount)},
	}
	is.PutOptional(&entries, "syncEpoch", manifest.SyncEpoch, is.Text)
	is.PutOptional(&entries, "takenBy", manifest.TakenBy, is.Text)
	var maxShards any
	if maximum, ok := manifest.Constraints.MaxShardsPerNode.Get(); ok {
		maxShards = float64(maximum)
	}
	is.Put(&entries, "replicationFactor", float64(manifest.ReplicationFactor))
	is.Put(&entries, "constraints", codec.OrderedMap{
		{Key: "zoneAwareness", Value: manifest.Constraints.ZoneAwareness},
		{Key: "zoneAttribute", Value: manifest.Constraints.ZoneAttribute},
		{Key: "maxShardsPerNode", Value: maxShards},
	})
	is.Put(&entries, "config", storedValue(manifest.Config))
	if history, ok := manifest.QueryHistory.Get(); ok {
		files := make([]any, len(history))
		for index, stored := range history {
			files[index] = storedValue(stored)
		}
		is.Put(&entries, "queryHistory", files)
	}
	partitions := make([]any, len(manifest.Partitions))
	for index, partition := range manifest.Partitions {
		partitions[index] = partitionValue(partition)
	}
	is.Put(&entries, "partitions", partitions)
	return entries
}

func Write(manifest Manifest) ([]byte, error) {
	payload, err := codec.Marshal(manifest.Value(), codec.EncodeOptions{ErrorCode: narsilerr.CodePersistenceSaveFailed})
	if err != nil {
		return nil, err
	}
	return envelope.Pack(payload, envelope.PackOptions{FormatVersion: FormatVersion, What: "backup manifest", Checksum: true})
}

func Read(data []byte, backupName string) (Manifest, envelope.Header, error) {
	opened, err := envelope.OpenChecksummed(data, envelope.Kind{
		FormatVersion: FormatVersion, What: "manifest of backup '" + backupName + "'", AllowsGzip: false,
	})
	if err != nil {
		return Manifest{}, envelope.Header{}, Damaged(backupName, "is not readable: "+messageOf(err))
	}
	raw, err := codec.Unmarshal(opened.Payload, codec.DecodeOptions{ErrorCode: narsilerr.CodeBackupDamaged})
	if err != nil {
		return Manifest{}, envelope.Header{}, Damaged(backupName, "is not readable: "+messageOf(err))
	}
	manifest, err := Decode(raw, backupName)
	return manifest, opened.Header, err
}

func ReadForm(data []byte, backupName string) ([]byte, error) {
	manifest, header, err := Read(data, backupName)
	if err != nil {
		return nil, err
	}
	return form.Encode(map[string]any{"header": form.HeaderOf(header).Value(), "payload": manifest.Value()})
}

func WriteForm(data []byte) ([]byte, error) {
	parsed, err := form.Decode(data)
	if err != nil {
		return nil, err
	}
	fields := form.NewFields(parsed, "", form.CodeJSONForm, "JSON form of the backup manifest")
	header := form.HeaderFrom(fields.Object("header"))
	payload := fields.Object("payload")
	name := payload.String("name")
	if err := fields.Err(); err != nil {
		return nil, err
	}
	manifest, err := Decode(payload.Map(), name)
	if err != nil {
		return nil, err
	}
	encoded, err := codec.Marshal(manifest.Value(), codec.EncodeOptions{ErrorCode: narsilerr.CodePersistenceSaveFailed})
	if err != nil {
		return nil, err
	}
	return envelope.Pack(encoded, header.PackOptions("backup manifest"))
}

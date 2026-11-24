package engine_test

import (
	"bytes"
	"context"
	"encoding/json"
	"strconv"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	statsJSONIndex              = "ledgers"
	statsJSONDocuments          = 40
	statsJSONMutationThreshold  = 25
	statsJSONPoll               = 20 * time.Millisecond
	statsJSONCheckpointDeadline = time.Minute
)

func encodedValue(t *testing.T, value any) any {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("encoding %T to JSON failed: %v", value, err)
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var decoded any
	if err := decoder.Decode(&decoded); err != nil {
		t.Fatalf("decoding the JSON %s failed: %v", encoded, err)
	}
	return decoded
}

func objectOf(t *testing.T, value any) map[string]any {
	t.Helper()
	object, isObject := value.(map[string]any)
	if !isObject {
		t.Fatalf("the JSON value %v is not an object", value)
	}
	return object
}

func encodedObject(t *testing.T, value any) map[string]any {
	t.Helper()
	return objectOf(t, encodedValue(t, value))
}

func encodedRows(t *testing.T, value any) []map[string]any {
	t.Helper()
	list, isList := encodedValue(t, value).([]any)
	if !isList {
		t.Fatalf("the JSON of %T is not a list", value)
	}
	rows := make([]map[string]any, len(list))
	for at, row := range list {
		rows[at] = objectOf(t, row)
	}
	return rows
}

func integerAt(object map[string]any, key string) (int64, bool) {
	number, isNumber := object[key].(json.Number)
	if !isNumber {
		return 0, false
	}
	value, err := strconv.ParseInt(number.String(), 10, 64)
	return value, err == nil
}

func requireNullAt(t *testing.T, label string, object map[string]any, key string) {
	t.Helper()
	value, present := object[key]
	if !present || value != nil {
		t.Fatalf("in %s, %s encodes as %v, present %v, where null is expected", label, key, value, present)
	}
}

func requireIntegerAt(t *testing.T, label string, object map[string]any, key string, expected int64) {
	t.Helper()
	if value, isInteger := integerAt(object, key); !isInteger || value != expected {
		t.Fatalf("in %s, %s encodes as %v, where the number %d is expected", label, key, object[key], expected)
	}
}

func ledgerDocuments() []*engine.Document {
	documents := make([]*engine.Document, statsJSONDocuments)
	for at := range documents {
		documents[at] = engine.DocumentFromMap(map[string]any{"id": "ledger-" + strconv.Itoa(at),
			"title": "ledger page " + strconv.Itoa(at)})
	}
	return documents
}

func createLedgers(t *testing.T, narsil *engine.Narsil) {
	t.Helper()
	config := engine.IndexConfig{Schema: engine.Schema{"title": engine.FieldString}}
	if err := narsil.CreateIndex(context.Background(), statsJSONIndex, config); err != nil {
		t.Fatalf("the engine refused the index with %s: %v", codeOrMessage(err), err)
	}
	insertEvery(t, narsil, statsJSONIndex, ledgerDocuments())
}

func durabilityFromJSON(t *testing.T, directory string) engine.DurabilityConfig {
	t.Helper()
	quotedDirectory, err := json.Marshal(directory)
	if err != nil {
		t.Fatalf("encoding the directory failed: %v", err)
	}
	text := `{"Directory":` + string(quotedDirectory) + `,"Mode":"sync","CheckpointInterval":0,` +
		`"FlushInterval":null,"CheckpointMutationThreshold":` + strconv.Itoa(statsJSONMutationThreshold) + `}`
	var durability engine.DurabilityConfig
	if err := json.Unmarshal([]byte(text), &durability); err != nil {
		t.Fatalf("decoding the durability config %s failed: %v", text, err)
	}
	if interval, set := durability.CheckpointInterval.Get(); !set || interval != 0 {
		t.Fatalf("the decoded checkpoint interval is %v, set %v, where a set 0 is expected", interval, set)
	}
	if threshold, set := durability.CheckpointMutationThreshold.Get(); !set || threshold != statsJSONMutationThreshold {
		t.Fatalf("the decoded mutation threshold is %d, set %v", threshold, set)
	}
	if durability.FlushInterval.IsSet() || durability.SegmentMaxBytes.IsSet() {
		t.Fatalf("a null flush interval or an absent segment size decoded as set")
	}
	encoded := encodedObject(t, durability)
	requireIntegerAt(t, "the durability config", encoded, "CheckpointInterval", 0)
	requireIntegerAt(t, "the durability config", encoded, "CheckpointMutationThreshold", statsJSONMutationThreshold)
	requireNullAt(t, "the durability config", encoded, "FlushInterval")
	requireNullAt(t, "the durability config", encoded, "SegmentMaxBytes")
	return durability
}

func statsMatchTheFiles(t *testing.T, narsil *engine.Narsil, directory string) (bool, string) {
	t.Helper()
	stats, err := narsil.GetStats(statsJSONIndex)
	if err != nil {
		t.Fatalf("reading the stats failed with %s: %v", codeOrMessage(err), err)
	}
	encoded := encodedObject(t, stats)
	saved, savedIsInteger := integerAt(encoded, "SavedBytes")
	logged, loggedIsInteger := integerAt(encoded, "LogBytes")
	savedOnDisk, loggedOnDisk := checkpointFileBytes(t, directory, statsJSONIndex), logFileBytes(t, directory,
		statsJSONIndex)
	if !savedIsInteger || !loggedIsInteger || saved == 0 || saved != savedOnDisk || logged != loggedOnDisk {
		return false, "the stats encode SavedBytes " + describeJSON(encoded["SavedBytes"]) +
			" and LogBytes " + describeJSON(encoded["LogBytes"]) + ", while the files hold " +
			strconv.FormatInt(savedOnDisk, 10) + " checkpoint bytes and " + strconv.FormatInt(loggedOnDisk, 10) +
			" log bytes"
	}
	partitions, err := narsil.GetPartitionStats(statsJSONIndex)
	if err != nil {
		t.Fatalf("reading the partition stats failed with %s: %v", codeOrMessage(err), err)
	}
	var partitionsSaved, partitionsLogged int64
	for _, row := range encodedRows(t, partitions) {
		partitionID, _ := integerAt(row, "PartitionID")
		onDisk := partitionCheckpointFileBytes(t, directory, statsJSONIndex, int(partitionID))
		partitionSaved, isInteger := integerAt(row, "SavedBytes")
		partitionLogged, logIsInteger := integerAt(row, "LogBytes")
		if !isInteger || !logIsInteger || partitionSaved != onDisk {
			return false, "partition " + strconv.FormatInt(partitionID, 10) + " encodes " +
				describeJSON(row) + ", while its checkpoint files hold " + strconv.FormatInt(onDisk, 10) + " bytes"
		}
		partitionsSaved += partitionSaved
		partitionsLogged += partitionLogged
	}
	if partitionsLogged != logged || partitionsSaved > saved {
		return false, "the partitions report " + strconv.FormatInt(partitionsLogged, 10) + " log bytes and " +
			strconv.FormatInt(partitionsSaved, 10) + " saved bytes between them, while the index reports " +
			strconv.FormatInt(logged, 10) + " and " + strconv.FormatInt(saved, 10)
	}
	return true, ""
}

func TestStatsAndDurabilityConfigEncodeToJSON(t *testing.T) {
	t.Run("a saved index encodes its sizes as numbers once the mutation threshold checkpoints it", func(t *testing.T) {
		directory := t.TempDir()
		durability := durabilityFromJSON(t, directory)
		narsil := openSavedSizeEngine(t, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
			Durability: &durability})
		createLedgers(t, narsil)
		deadline := time.Now().Add(statsJSONCheckpointDeadline)
		for {
			matched, mismatch := statsMatchTheFiles(t, narsil, directory)
			if matched {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("with a checkpoint interval of 0 and a mutation threshold of %d, %s after %s",
					statsJSONMutationThreshold, mismatch, statsJSONCheckpointDeadline)
			}
			time.Sleep(statsJSONPoll)
		}
	})

	t.Run("a text checkpoint interval fails to decode", func(t *testing.T) {
		var refused engine.DurabilityConfig
		if err := json.Unmarshal([]byte(`{"CheckpointInterval":"soon"}`), &refused); err == nil {
			t.Fatalf("a text checkpoint interval decoded without an error into %v", refused.CheckpointInterval)
		}
	})

	t.Run("an index without durability encodes its sizes as null", func(t *testing.T) {
		narsil := openSavedSizeEngine(t, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)}})
		createLedgers(t, narsil)
		stats, err := narsil.GetStats(statsJSONIndex)
		if err != nil {
			t.Fatalf("reading the stats failed with %s: %v", codeOrMessage(err), err)
		}
		encoded := encodedObject(t, stats)
		requireIntegerAt(t, "the stats", encoded, "DocumentCount", statsJSONDocuments)
		requireNullAt(t, "the stats", encoded, "SavedBytes")
		requireNullAt(t, "the stats", encoded, "LogBytes")
		partitions, err := narsil.GetPartitionStats(statsJSONIndex)
		if err != nil {
			t.Fatalf("reading the partition stats failed with %s: %v", codeOrMessage(err), err)
		}
		rows := encodedRows(t, partitions)
		if len(rows) == 0 {
			t.Fatalf("the partition stats list no partition")
		}
		for _, row := range rows {
			requireNullAt(t, "the partition stats", row, "SavedBytes")
			requireNullAt(t, "the partition stats", row, "LogBytes")
		}
	})
}

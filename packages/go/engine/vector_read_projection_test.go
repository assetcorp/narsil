package engine_test

import (
	"bytes"
	"context"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	vectorReadIndex     = "vector-reads"
	vectorReadDimension = 4
	vectorReadWriters   = 4
	vectorReadReaders   = 4
	vectorReadVersions  = 40
)

type vectorReadCase struct {
	name       string
	projection engine.DocumentProjection
	expected   func(record map[string]any) map[string]any
}

func vectorReadSchema() engine.Schema {
	return engine.Schema{
		"title":     engine.FieldString,
		"embedding": engine.VectorFieldType(vectorReadDimension),
		"meta": engine.Schema{
			"source":    engine.FieldString,
			"embedding": engine.VectorFieldType(vectorReadDimension),
		},
	}
}

func vectorReadRecords() map[string]map[string]any {
	records := map[string]map[string]any{}
	for serial, id := range []string{"alpha", "bravo", "charlie"} {
		base := float32(serial + 1)
		records[id] = map[string]any{
			"id":        id,
			"title":     "shared title " + id,
			"embedding": []float32{base, base / 2, base / 4, base / 8},
			"meta": map[string]any{
				"source":    "source " + id,
				"embedding": []float32{-base, base, -base, base},
			},
		}
	}
	return records
}

func copiedRecord(record map[string]any) map[string]any {
	copied := make(map[string]any, len(record))
	for key, value := range record {
		switch typed := value.(type) {
		case map[string]any:
			copied[key] = copiedRecord(typed)
		case []float32:
			copied[key] = append([]float32(nil), typed...)
		default:
			copied[key] = value
		}
	}
	return copied
}

func recordWithout(record map[string]any, paths ...string) map[string]any {
	kept := copiedRecord(record)
	for _, path := range paths {
		segments := strings.Split(path, ".")
		holder := kept
		for _, segment := range segments[:len(segments)-1] {
			next, isMap := holder[segment].(map[string]any)
			if !isMap {
				holder = nil
				break
			}
			holder = next
		}
		if holder != nil {
			delete(holder, segments[len(segments)-1])
		}
	}
	return kept
}

func recordOnly(record map[string]any, keys ...string) map[string]any {
	kept := map[string]any{}
	for _, key := range keys {
		if value, held := record[key]; held {
			kept[key] = value
		}
	}
	return copiedRecord(kept)
}

func defaultVectorReadCases() []vectorReadCase {
	return []vectorReadCase{
		{"with no projection", engine.DocumentProjection{}, func(record map[string]any) map[string]any {
			return recordWithout(record, "embedding", "meta.embedding")
		}},
		{"with vectors asked for", engine.ReturnVectors(true), copiedRecord},
		{"with vectors refused", engine.ReturnVectors(false), func(record map[string]any) map[string]any {
			return recordWithout(record, "embedding", "meta.embedding")
		}},
		{"including a vector field by name", engine.IncludeFields("embedding"), func(record map[string]any) map[string]any {
			return recordOnly(record, "embedding")
		}},
		{"including a vector field by a path with empty segments", engine.IncludeFields(".embedding.", "title"),
			func(record map[string]any) map[string]any { return recordOnly(record, "embedding", "title") }},
		{"including the object that holds a nested vector", engine.IncludeFields("meta"), func(record map[string]any) map[string]any {
			return recordWithout(recordOnly(record, "meta"), "meta.embedding")
		}},
		{"including the nested vector by its whole path", engine.IncludeFields("meta.embedding"), func(record map[string]any) map[string]any {
			return recordWithout(recordOnly(record, "meta"), "meta.source")
		}},
		{"including the nested object with vectors asked for", engine.IncludeFields("meta").WithVectors(true),
			func(record map[string]any) map[string]any { return recordOnly(record, "meta") }},
		{"naming a vector field while refusing vectors", engine.IncludeFields("embedding", "title").WithVectors(false),
			func(record map[string]any) map[string]any { return recordOnly(record, "title") }},
		{"asking for vectors while including only text", engine.IncludeFields("title").WithVectors(true),
			func(record map[string]any) map[string]any { return recordOnly(record, "title") }},
		{"include paths cannot enter vector arrays", engine.IncludeFields("title", "embedding.0", "meta.embedding.0").WithVectors(true),
			func(record map[string]any) map[string]any { return recordOnly(record, "title") }},
		{"asking for vectors while excluding one", engine.ReturnVectors(true).Excluding("embedding"),
			func(record map[string]any) map[string]any { return recordWithout(record, "embedding") }},
		{"asking for vectors with no fields", engine.NoDocumentFields().WithVectors(true),
			func(map[string]any) map[string]any { return map[string]any{} }},
	}
}

func returningVectorReadCases() []vectorReadCase {
	return []vectorReadCase{
		{"with no projection", engine.DocumentProjection{}, copiedRecord},
		{"with vectors refused", engine.ReturnVectors(false), func(record map[string]any) map[string]any {
			return recordWithout(record, "embedding", "meta.embedding")
		}},
		{"including only text", engine.IncludeFields("title"), func(record map[string]any) map[string]any {
			return recordOnly(record, "title")
		}},
		{"including the object that holds a nested vector", engine.IncludeFields("meta"), func(record map[string]any) map[string]any {
			return recordOnly(record, "meta")
		}},
		{"excluding one vector field", engine.ExcludeFields("meta.embedding"), func(record map[string]any) map[string]any {
			return recordWithout(record, "meta.embedding")
		}},
	}
}

func vectorReadEngine(t *testing.T, config engine.Config) *engine.Narsil {
	t.Helper()
	config.Workers = engine.WorkerConfig{Enabled: engine.Some(false)}
	narsil, err := engine.New(context.Background(), config)
	if err != nil {
		t.Fatalf("the engine refused to start with %s: %v", codeOrMessage(err), err)
	}
	t.Cleanup(func() { _ = narsil.Shutdown(context.Background()) })
	return narsil
}

func createVectorReadIndex(t *testing.T, narsil *engine.Narsil, name string, returnVectors bool) map[string]map[string]any {
	t.Helper()
	ctx := context.Background()
	if err := narsil.CreateIndex(ctx, name, engine.IndexConfig{Language: "english", Schema: vectorReadSchema(),
		ReturnVectors: returnVectors}); err != nil {
		t.Fatalf("the engine refused the index with %s: %v", codeOrMessage(err), err)
	}
	records := vectorReadRecords()
	documents := make([]*engine.Document, 0, len(records))
	for _, record := range records {
		documents = append(documents, engine.DocumentFromMap(copiedRecord(record)))
	}
	if _, err := narsil.InsertBatch(ctx, name, documents, engine.InsertOptions{}); err != nil {
		t.Fatalf("the engine refused the documents with %s: %v", codeOrMessage(err), err)
	}
	return records
}

func requireRecordShown(t *testing.T, read string, id string, shown *engine.Document, expected map[string]any) {
	t.Helper()
	got := shown.Map()
	if got == nil {
		got = map[string]any{}
	}
	if !reflect.DeepEqual(got, expected) {
		t.Fatalf("%s returned %#v for %s, while the read asks for %#v", read, got, id, expected)
	}
}

func readEveryWay(t *testing.T, narsil *engine.Narsil, name string, records map[string]map[string]any, read vectorReadCase) {
	t.Helper()
	ctx := context.Background()
	for id, record := range records {
		document, found, err := narsil.Get(ctx, name, id, read.projection)
		if err != nil || !found {
			t.Fatalf("Get found %t for %s with %s: %v", found, id, codeOrMessage(err), err)
		}
		requireRecordShown(t, "Get", id, document, read.expected(record))
	}
	ids := []string{"missing"}
	for id := range records {
		ids = append(ids, id)
	}
	several, err := narsil.GetMultiple(ctx, name, ids, read.projection)
	if err != nil || len(several) != len(records) {
		t.Fatalf("GetMultiple returned %d documents with %s: %v", len(several), codeOrMessage(err), err)
	}
	for id, document := range several {
		requireRecordShown(t, "GetMultiple", id, document, read.expected(records[id]))
	}
	listed, err := narsil.ListDocuments(ctx, name, engine.ListParams{Document: read.projection})
	if err != nil || len(listed.Documents) != len(records) {
		t.Fatalf("ListDocuments returned %d documents with %s: %v", len(listed.Documents), codeOrMessage(err), err)
	}
	for _, document := range listed.Documents {
		requireRecordShown(t, "ListDocuments", document.ID, document.Document, read.expected(records[document.ID]))
	}
	result, err := narsil.Query(ctx, name, engine.QueryParams{Term: "shared", Document: read.projection})
	if err != nil || len(result.Hits) != len(records) {
		t.Fatalf("Query returned %d hits with %s: %v", len(result.Hits), codeOrMessage(err), err)
	}
	for _, hit := range result.Hits {
		requireRecordShown(t, "a search hit", hit.ID, hit.Document, read.expected(records[hit.ID]))
	}
	grouped, err := narsil.Query(ctx, name, engine.QueryParams{Term: "shared", Document: read.projection,
		Group: &engine.GroupConfig{Fields: []string{"meta.source"}}})
	if err != nil || len(grouped.Groups) != len(records) {
		t.Fatalf("the grouped query returned %d groups with %s: %v", len(grouped.Groups), codeOrMessage(err), err)
	}
	for _, group := range grouped.Groups {
		for _, hit := range group.Hits {
			requireRecordShown(t, "a grouped hit", hit.ID, hit.Document, read.expected(records[hit.ID]))
		}
	}
}

func TestEveryReadLeavesVectorFieldsOutUnlessItAsksForThem(t *testing.T) {
	narsil := vectorReadEngine(t, engine.Config{})
	records := createVectorReadIndex(t, narsil, vectorReadIndex, false)
	for _, read := range defaultVectorReadCases() {
		t.Run(read.name, func(t *testing.T) { readEveryWay(t, narsil, vectorReadIndex, records, read) })
	}
	_, _, err := narsil.Get(context.Background(), vectorReadIndex, "alpha", engine.ReturnVectors(false), engine.ReturnVectors(true))
	if engine.ErrorCode(err) != engine.CodeSearchInvalidField {
		t.Fatalf("Get with two projections returned %s, while it must refuse them with %s", codeOrMessage(err),
			engine.CodeSearchInvalidField)
	}
	if _, err := narsil.GetMultiple(context.Background(), vectorReadIndex, []string{"alpha"}, engine.ReturnVectors(true),
		engine.ReturnVectors(true)); engine.ErrorCode(err) != engine.CodeSearchInvalidField {
		t.Fatalf("GetMultiple with two projections returned %s, while it must refuse them with %s", codeOrMessage(err),
			engine.CodeSearchInvalidField)
	}
}

func storeNullVectors(t *testing.T, narsil *engine.Narsil, name string, records map[string]map[string]any) {
	t.Helper()
	ctx := context.Background()
	records["delta"] = map[string]any{"id": "delta", "title": "shared title delta", "embedding": nil,
		"meta": map[string]any{"source": "source delta", "embedding": nil}}
	if _, err := narsil.Insert(ctx, name, engine.DocumentFromMap(copiedRecord(records["delta"])), "",
		engine.InsertOptions{}); err != nil {
		t.Fatalf("the engine refused a document with null vectors with %s: %v", codeOrMessage(err), err)
	}
	records["charlie"]["embedding"] = nil
	records["charlie"]["meta"].(map[string]any)["embedding"] = nil
	if err := narsil.Update(ctx, name, "charlie", engine.DocumentFromMap(copiedRecord(records["charlie"])),
		engine.WriteOptions{}); err != nil {
		t.Fatalf("the engine refused an update to null vectors with %s: %v", codeOrMessage(err), err)
	}
}

func TestAnIndexThatReturnsVectorsKeepsDoingSoAfterARestartARestoreAndAnImport(t *testing.T) {
	ctx := context.Background()
	directory := t.TempDir()
	first, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync}})
	if err != nil {
		t.Fatalf("the engine refused to start with %s: %v", codeOrMessage(err), err)
	}
	records := createVectorReadIndex(t, first, "returning", true)
	storeNullVectors(t, first, "returning", records)
	storeNullVectors(t, first, "leaving", createVectorReadIndex(t, first, "leaving", false))
	for _, read := range returningVectorReadCases() {
		t.Run("before a restart "+read.name, func(t *testing.T) { readEveryWay(t, first, "returning", records, read) })
	}
	if err := first.Shutdown(ctx); err != nil {
		t.Fatalf("the engine refused to shut down with %s: %v", codeOrMessage(err), err)
	}
	reopened := vectorReadEngine(t, engine.Config{Durability: &engine.DurabilityConfig{Directory: directory,
		Mode: engine.DurabilitySync}})
	for _, read := range returningVectorReadCases() {
		t.Run("after a restart "+read.name, func(t *testing.T) { readEveryWay(t, reopened, "returning", records, read) })
	}
	leaving := defaultVectorReadCases()[0]
	t.Run("after a restart, an index that leaves vectors out", func(t *testing.T) {
		readEveryWay(t, reopened, "leaving", records, leaving)
	})
	var snapshot bytes.Buffer
	if err := reopened.Snapshot(ctx, "returning", engine.SnapshotOptions{}, &snapshot); err != nil {
		t.Fatalf("the snapshot failed with %s: %v", codeOrMessage(err), err)
	}
	var exported bytes.Buffer
	if err := reopened.ExportDocuments(ctx, "returning", &exported); err != nil {
		t.Fatalf("the export failed with %s: %v", codeOrMessage(err), err)
	}
	restored := vectorReadEngine(t, engine.Config{})
	if err := restored.Restore(ctx, "restored", bytes.NewReader(snapshot.Bytes())); err != nil {
		t.Fatalf("the restore failed with %s: %v", codeOrMessage(err), err)
	}
	if _, err := restored.ImportDocumentExport(ctx, "imported", bytes.NewReader(exported.Bytes())); err != nil {
		t.Fatalf("the import failed with %s: %v", codeOrMessage(err), err)
	}
	for _, read := range returningVectorReadCases() {
		t.Run("after a restore "+read.name, func(t *testing.T) { readEveryWay(t, restored, "restored", records, read) })
		t.Run("after an import "+read.name, func(t *testing.T) { readEveryWay(t, restored, "imported", records, read) })
	}
}

func TestAnImportRefusesAReturnVectorsSettingThatIsNotABoolean(t *testing.T) {
	ctx := context.Background()
	narsil := vectorReadEngine(t, engine.Config{})
	for name, setting := range map[string]string{"a string": `"true"`, "a number": `1`, "null": `null`, "a list": `[true]`} {
		t.Run(name, func(t *testing.T) {
			header := `{"format":"narsil-export","version":1,"index":{"schema":{"title":"string"},"language":"english",` +
				`"returnVectors":` + setting + "}}\n" + `{"id":"one","title":"shared"}` + "\n"
			_, err := narsil.ImportDocumentExport(ctx, "hostile", strings.NewReader(header))
			if engine.ErrorCode(err) != engine.CodeConfigInvalid {
				t.Fatalf("the import returned %s for returnVectors %s, while it must refuse it with %s", codeOrMessage(err),
					setting, engine.CodeConfigInvalid)
			}
			if _, _, err := narsil.Get(ctx, "hostile", "one"); engine.ErrorCode(err) != engine.CodeIndexNotFound {
				t.Fatalf("after the refused import, Get returned %s, while the index must be missing", codeOrMessage(err))
			}
		})
	}
}

func versionedVector(version int) []float32 {
	value := float32(version)
	return []float32{value, value, value, value}
}

func requireVersionedVector(value any, held bool) error {
	vector, isVector := value.([]float32)
	if !held || !isVector || len(vector) != vectorReadDimension {
		return fmt.Errorf("the read asked for vectors and returned %#v", value)
	}
	for _, element := range vector {
		if element != vector[0] || element < 0 || element > vectorReadVersions || element != float32(int(element)) {
			return fmt.Errorf("the read returned the vector %v, which no write stored", vector)
		}
	}
	return nil
}

func checkConcurrentRead(narsil *engine.Narsil, id string) error {
	ctx := context.Background()
	left, found, err := narsil.Get(ctx, vectorReadIndex, id)
	if err != nil || !found {
		return fmt.Errorf("Get found %t for %s: %v", found, id, err)
	}
	if value, held := left.Get("embedding"); held {
		return fmt.Errorf("a read without a projection returned the vector %v", value)
	}
	whole, found, err := narsil.Get(ctx, vectorReadIndex, id, engine.ReturnVectors(true))
	if err != nil || !found {
		return fmt.Errorf("Get with vectors found %t for %s: %v", found, id, err)
	}
	if err := requireVersionedVector(whole.Get("embedding")); err != nil {
		return err
	}
	result, err := narsil.Query(ctx, vectorReadIndex, engine.QueryParams{Term: "shared"})
	if err != nil {
		return err
	}
	for _, hit := range result.Hits {
		if value, held := hit.Document.Get("embedding"); held {
			return fmt.Errorf("a search hit without a projection returned the vector %v", value)
		}
	}
	return nil
}

func TestReadsDuringConcurrentWritesReturnVectorsOnlyWhenAsked(t *testing.T) {
	ctx := context.Background()
	narsil := vectorReadEngine(t, engine.Config{})
	if err := narsil.CreateIndex(ctx, vectorReadIndex, engine.IndexConfig{Language: "english",
		Schema: engine.Schema{"title": engine.FieldString, "embedding": engine.VectorFieldType(vectorReadDimension)}}); err != nil {
		t.Fatalf("the engine refused the index with %s: %v", codeOrMessage(err), err)
	}
	ids := make([]string, vectorReadWriters)
	for writer := range ids {
		ids[writer] = fmt.Sprintf("written-%d", writer)
		document := engine.NewDocument().Set("id", ids[writer]).Set("title", "shared 0").Set("embedding", versionedVector(0))
		if _, err := narsil.Insert(ctx, vectorReadIndex, document, "", engine.InsertOptions{}); err != nil {
			t.Fatalf("the engine refused the document with %s: %v", codeOrMessage(err), err)
		}
	}
	failures := make(chan error, vectorReadWriters+vectorReadReaders)
	var writers, readers sync.WaitGroup
	stop := make(chan struct{})
	for writer, id := range ids {
		writers.Add(1)
		go func() {
			defer writers.Done()
			for version := 1; version <= vectorReadVersions; version++ {
				document := engine.NewDocument().Set("id", id).Set("title", fmt.Sprintf("shared %d", version)).
					Set("embedding", versionedVector(version))
				if err := narsil.Update(ctx, vectorReadIndex, id, document, engine.WriteOptions{}); err != nil {
					failures <- fmt.Errorf("writer %d failed: %w", writer, err)
					return
				}
			}
		}()
	}
	for reader := range vectorReadReaders {
		readers.Add(1)
		go func() {
			defer readers.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				if err := checkConcurrentRead(narsil, ids[reader%len(ids)]); err != nil {
					failures <- err
					return
				}
			}
		}()
	}
	writers.Wait()
	close(stop)
	readers.Wait()
	close(failures)
	for failure := range failures {
		t.Fatal(failure)
	}
}

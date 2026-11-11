package engine_test

import (
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/backup"
)

const (
	damagedCaseDeadline   = 60 * time.Second
	maxGunzippedExport    = 128 << 20
	damagedSearchHitLimit = 10
)

var vectorTypePattern = regexp.MustCompile(`^vector\[(\d+)\]$`)

type damagedCase struct {
	Name   string            `json:"name"`
	Open   string            `json:"open"`
	Index  string            `json:"index"`
	Base   string            `json:"base"`
	File   string            `json:"file"`
	Gzip   bool              `json:"gzip"`
	Files  map[string]string `json:"files"`
	Remove string            `json:"remove"`
	Search string            `json:"search"`
	Expect struct {
		Code      string `json:"code"`
		Line      int    `json:"line"`
		Imported  int    `json:"imported"`
		Documents string `json:"documents"`
	} `json:"expect"`
}

type caseOutcome struct {
	refused   error
	documents map[string]any
	imported  int
	refusals  []engine.ImportRefusal
}

func searchEveryVectorField(ctx context.Context, narsil *engine.Narsil, indexName string) error {
	stats, err := narsil.GetStats(indexName)
	if err != nil {
		return err
	}
	for field, fieldType := range stats.Schema {
		described, isText := fieldType.(engine.FieldType)
		if !isText {
			continue
		}
		match := vectorTypePattern.FindStringSubmatch(string(described))
		if match == nil {
			continue
		}
		dimension, _ := strconv.Atoi(match[1])
		value := make([]float32, dimension)
		value[0] = 1
		if _, err := narsil.Query(ctx, indexName, engine.QueryParams{Mode: engine.SearchVector, Limit: engine.Some(damagedSearchHitLimit),
			Vector: &engine.VectorQueryConfig{Field: field, Value: value}}); err != nil {
			return err
		}
	}
	return nil
}

func withShutdown(ctx context.Context, narsil *engine.Narsil, outcome caseOutcome) caseOutcome {
	err := narsil.Shutdown(ctx)
	if outcome.refused == nil && err != nil {
		return caseOutcome{refused: err}
	}
	return outcome
}

func openDamagedCheckpoint(t *testing.T, ctx context.Context, root string, entry damagedCase) caseOutcome {
	directory := filepath.Join(root, entry.Index)
	copyTree(t, samplesPath(entry.Base), directory)
	for relative, source := range entry.Files {
		overlayFile(t, samplesPath(source), filepath.Join(directory, filepath.FromSlash(relative)))
	}
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: &engine.DurabilityConfig{Directory: root}})
	if err != nil {
		return caseOutcome{refused: err}
	}
	if entry.Remove != "" {
		if err := narsil.Remove(ctx, entry.Index, entry.Remove, engine.WriteOptions{}); err != nil {
			return withShutdown(ctx, narsil, caseOutcome{refused: err})
		}
	}
	if entry.Search != "" {
		if _, err := narsil.Query(ctx, entry.Index, engine.QueryParams{Term: entry.Search, Limit: engine.Some(damagedSearchHitLimit)}); err != nil {
			return withShutdown(ctx, narsil, caseOutcome{refused: err})
		}
	}
	if err := searchEveryVectorField(ctx, narsil, entry.Index); err != nil {
		return withShutdown(ctx, narsil, caseOutcome{refused: err})
	}
	documents, err := exportedDocuments(ctx, narsil, entry.Index)
	return withShutdown(ctx, narsil, caseOutcome{refused: err, documents: documents})
}

func exportSource(t *testing.T, entry damagedCase) io.Reader {
	stored, err := os.ReadFile(samplesPath(entry.File))
	if err != nil {
		t.Fatalf("reading %s failed: %v", entry.File, err)
	}
	if !entry.Gzip {
		return bytes.NewReader(stored)
	}
	unzipped, err := gzip.NewReader(bytes.NewReader(stored))
	if err != nil {
		t.Fatalf("%s is not gzip: %v", entry.File, err)
	}
	data, err := io.ReadAll(io.LimitReader(unzipped, maxGunzippedExport))
	if err != nil {
		t.Fatalf("gunzipping %s failed: %v", entry.File, err)
	}
	return bytes.NewReader(data)
}

func openDamagedThroughEngine(t *testing.T, ctx context.Context, root string, entry damagedCase) caseOutcome {
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: &engine.DurabilityConfig{Directory: root, Mode: engine.DurabilitySync}})
	if err != nil {
		return caseOutcome{refused: err}
	}
	if entry.Open == "archive" {
		data, readErr := os.ReadFile(samplesPath(entry.File))
		if readErr != nil {
			t.Fatalf("reading %s failed: %v", entry.File, readErr)
		}
		if err := narsil.Restore(ctx, entry.Index, bytes.NewReader(data)); err != nil {
			return withShutdown(ctx, narsil, caseOutcome{refused: err})
		}
		documents, err := exportedDocuments(ctx, narsil, entry.Index)
		return withShutdown(ctx, narsil, caseOutcome{refused: err, documents: documents})
	}
	result, err := narsil.ImportDocumentExport(ctx, entry.Index, exportSource(t, entry))
	if err != nil {
		return withShutdown(ctx, narsil, caseOutcome{refused: err})
	}
	if result.RefusedCount > 0 {
		return withShutdown(ctx, narsil, caseOutcome{imported: result.Imported, refusals: result.Refused})
	}
	documents, err := exportedDocuments(ctx, narsil, entry.Index)
	return withShutdown(ctx, narsil, caseOutcome{refused: err, documents: documents})
}

func openDamagedCase(t *testing.T, entry damagedCase) caseOutcome {
	ctx, cancel := context.WithTimeout(context.Background(), damagedCaseDeadline)
	defer cancel()
	root := t.TempDir()
	switch entry.Open {
	case "checkpoint":
		return openDamagedCheckpoint(t, ctx, root, entry)
	case "archive", "export":
		return openDamagedThroughEngine(t, ctx, root, entry)
	case "backup":
		data, err := os.ReadFile(samplesPath(entry.File))
		if err != nil {
			t.Fatalf("reading %s failed: %v", entry.File, err)
		}
		_, _, err = backup.Read(data, entry.Name)
		return caseOutcome{refused: err}
	}
	t.Fatalf("cases.json opens %s in an unknown way %q", entry.Name, entry.Open)
	return caseOutcome{}
}

func judgeDamagedCase(t *testing.T, entry damagedCase, outcome caseOutcome) {
	switch {
	case entry.Expect.Documents != "":
		if outcome.refused != nil {
			t.Fatalf("the case must open, but it raised %s: %v", codeOrMessage(outcome.refused), outcome.refused)
		}
		if len(outcome.refusals) > 0 {
			t.Fatalf("the case must open, but the import refused %+v", outcome.refusals)
		}
		var expected any
		readJSONFile(t, samplesPath(entry.Expect.Documents), &expected)
		if difference := contentDifference(expected, any(outcome.documents), "", true); difference != "" {
			t.Fatalf("the opened documents differ at %s", difference)
		}
	case entry.Expect.Line > 0:
		if outcome.refused != nil {
			t.Fatalf("the import must refuse line %d, but it raised %s: %v", entry.Expect.Line, codeOrMessage(outcome.refused), outcome.refused)
		}
		want := fmt.Sprintf("imported %d, refused line %d with %s", entry.Expect.Imported, entry.Expect.Line, entry.Expect.Code)
		got := fmt.Sprintf("imported %d, refused %d lines", outcome.imported, len(outcome.refusals))
		if len(outcome.refusals) == 1 {
			got = fmt.Sprintf("imported %d, refused line %d with %s", outcome.imported, outcome.refusals[0].Line, outcome.refusals[0].Code)
		}
		if want != got {
			t.Fatalf("the import must have %s, but it %s", want, got)
		}
	default:
		if outcome.refused == nil {
			t.Fatalf("the case must raise %s, but it opened", entry.Expect.Code)
		}
		if got := codeOrMessage(outcome.refused); got != entry.Expect.Code {
			t.Fatalf("the case must raise %s, but it raised %s: %v", entry.Expect.Code, got, outcome.refused)
		}
	}
}

func TestConformanceDamagedFilesRaiseTheirCodeAndSoundFilesOpen(t *testing.T) {
	var listing struct {
		Cases []damagedCase `json:"cases"`
	}
	readJSONFile(t, samplesPath("damaged", "cases.json"), &listing)
	if len(listing.Cases) == 0 {
		t.Fatal("cases.json lists no case")
	}
	for _, entry := range listing.Cases {
		t.Run(entry.Open+" "+entry.Name, func(t *testing.T) {
			judgeDamagedCase(t, entry, openDamagedCase(t, entry))
		})
	}
}

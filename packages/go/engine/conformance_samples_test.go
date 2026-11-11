package engine_test

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

type conformanceSample struct {
	Name     string `json:"name"`
	Kind     string `json:"kind"`
	File     string `json:"file"`
	Expected string `json:"expected"`
	Storage  string `json:"storage"`
}

type earlierRelease struct {
	Release string            `json:"release"`
	Layout  string            `json:"layout"`
	Path    string            `json:"path"`
	Indexes map[string]string `json:"indexes"`
}

func TestConformanceSamplesReadAndWriteTheirExpectedContent(t *testing.T) {
	var listing struct {
		Samples []conformanceSample `json:"samples"`
	}
	readJSONFile(t, samplesPath("samples.json"), &listing)
	if len(listing.Samples) == 0 {
		t.Fatal("samples.json lists no samples")
	}
	for _, sample := range listing.Samples {
		t.Run(sample.Name, func(t *testing.T) {
			raw, err := os.ReadFile(samplesPath(sample.File))
			if err != nil {
				t.Fatalf("reading the sample failed: %v", err)
			}
			expectedData, err := os.ReadFile(samplesPath(sample.Expected))
			if err != nil {
				t.Fatalf("reading the expected JSON failed: %v", err)
			}
			expected, err := decodedJSON(expectedData)
			if err != nil {
				t.Fatalf("the expected JSON does not parse: %v", err)
			}
			signedZero := sample.Kind == "document-export"
			requireSameForm(t, "reading the sample", sample, raw, expected, signedZero)
			written, err := writeSampleForm(sample.Kind, expectedData, sample.Name)
			if err != nil {
				t.Fatalf("writing a %s from the expected JSON failed: %v", sample.Kind, err)
			}
			requireSameForm(t, "reading the file written from the expected JSON", sample, written, expected, signedZero)
		})
	}
}

func requireSameForm(t *testing.T, step string, sample conformanceSample, data []byte, expected any, signedZero bool) {
	t.Helper()
	read, err := readSampleForm(sample.Kind, data, sample.Storage, sample.Name)
	if err != nil {
		t.Fatalf("%s failed with %s: %v", step, codeOrMessage(err), err)
	}
	actual, err := decodedJSON(read)
	if err != nil {
		t.Fatalf("%s produced JSON that does not parse: %v", step, err)
	}
	if difference := contentDifference(expected, actual, "", signedZero); difference != "" {
		t.Fatalf("%s gave content that differs from the expected JSON at %s", step, difference)
	}
}

type directoryPersistence struct {
	root string
}

func (store directoryPersistence) pathOf(key string) string {
	return filepath.Join(store.root, filepath.FromSlash(key))
}

func (store directoryPersistence) Save(_ context.Context, key string, data []byte) error {
	target := store.pathOf(key)
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	partial := target + ".partial"
	if err := os.WriteFile(partial, data, 0o644); err != nil {
		return err
	}
	return os.Rename(partial, target)
}

func (store directoryPersistence) Load(_ context.Context, key string) ([]byte, bool, error) {
	data, err := os.ReadFile(store.pathOf(key))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, false, nil
	}
	return data, err == nil, err
}

func (store directoryPersistence) Delete(_ context.Context, key string) error {
	err := os.Remove(store.pathOf(key))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

func (store directoryPersistence) List(_ context.Context, prefix string) ([]string, error) {
	keys := []string{}
	err := filepath.WalkDir(store.root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() || strings.HasSuffix(path, ".partial") {
			return err
		}
		relative, err := filepath.Rel(store.root, path)
		if err != nil {
			return err
		}
		if key := filepath.ToSlash(relative); strings.HasPrefix(key, prefix) {
			keys = append(keys, key)
		}
		return nil
	})
	sort.Strings(keys)
	return keys, err
}

func openEarlierRelease(t *testing.T, ctx context.Context, release earlierRelease, root string) *engine.Narsil {
	t.Helper()
	source := samplesPath(release.Path)
	disabled := engine.WorkerConfig{Enabled: engine.Some(false)}
	var config engine.Config
	switch release.Layout {
	case "index-snapshot":
		config = engine.Config{Workers: disabled, Durability: &engine.DurabilityConfig{Directory: root, Mode: engine.DurabilitySync}}
	case "checkpoint-directory":
		copyTree(t, source, root)
		config = engine.Config{Workers: disabled, Durability: &engine.DurabilityConfig{Directory: root}}
	case "snapshot-bundle":
		copyTree(t, source, root)
		config = engine.Config{Workers: disabled, Persistence: directoryPersistence{root: root},
			Durability: &engine.DurabilityConfig{Tier: engine.DurabilitySnapshot}}
	default:
		t.Fatalf("releases.json lists an unknown layout %q", release.Layout)
	}
	narsil, err := engine.New(ctx, config)
	if err != nil {
		t.Fatalf("the engine refused to open the %s with %s: %v", release.Layout, codeOrMessage(err), err)
	}
	t.Cleanup(func() { _ = narsil.Shutdown(context.Background()) })
	if release.Layout != "index-snapshot" {
		return narsil
	}
	data, err := os.ReadFile(source)
	if err != nil {
		t.Fatalf("reading the index snapshot failed: %v", err)
	}
	for indexName := range release.Indexes {
		if err := narsil.Restore(ctx, indexName, bytes.NewReader(data)); err != nil {
			t.Fatalf("restoring the index snapshot into %s failed with %s: %v", indexName, codeOrMessage(err), err)
		}
	}
	return narsil
}

func TestConformanceEarlierReleasesOpenWithEveryDocumentTheyHeld(t *testing.T) {
	var listing struct {
		Earlier []earlierRelease `json:"earlier"`
	}
	readJSONFile(t, samplesPath("earlier-releases", "releases.json"), &listing)
	if len(listing.Earlier) == 0 {
		t.Fatal("releases.json lists no earlier release")
	}
	for _, release := range listing.Earlier {
		t.Run(release.Release+" "+release.Layout+" "+release.Path, func(t *testing.T) {
			ctx := context.Background()
			narsil := openEarlierRelease(t, ctx, release, t.TempDir())
			for indexName, expectedPath := range release.Indexes {
				var expected any
				readJSONFile(t, samplesPath(expectedPath), &expected)
				documents, err := exportedDocuments(ctx, narsil, indexName)
				if err != nil {
					t.Fatalf("exporting %s failed with %s: %v", indexName, codeOrMessage(err), err)
				}
				recovered := map[string]any(documents)
				if difference := contentDifference(expected, any(recovered), indexName, false); difference != "" {
					t.Fatalf("the documents recovered from %s differ at %s", indexName, difference)
				}
			}
		})
	}
}

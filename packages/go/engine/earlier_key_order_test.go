package engine_test

import (
	"bytes"
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

func jsonKeyPaths(t *testing.T, data []byte) []string {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(data))
	var paths []string
	var walk func(prefix string) error
	walk = func(prefix string) error {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		delimiter, opens := token.(json.Delim)
		if !opens {
			return nil
		}
		for decoder.More() {
			path := prefix
			if delimiter == '{' {
				key, err := decoder.Token()
				if err != nil {
					return err
				}
				path = prefix + "/" + key.(string)
				paths = append(paths, path)
			}
			if err := walk(path); err != nil {
				return err
			}
		}
		_, err = decoder.Token()
		return err
	}
	if err := walk(""); err != nil {
		t.Fatalf("the JSON %s does not parse: %v", data, err)
	}
	return paths
}

func withoutTopLevelID(paths []string) []string {
	return slices.DeleteFunc(paths, func(path string) bool { return path == "/id" || strings.HasPrefix(path, "/id/") })
}

func TestConformanceEarlierReleasesKeepTheKeyOrderOfEveryDocument(t *testing.T) {
	var listing struct {
		Earlier []earlierRelease `json:"earlier"`
	}
	readJSONFile(t, samplesPath("earlier-releases", "releases.json"), &listing)
	for _, release := range listing.Earlier {
		t.Run(release.Release+" "+release.Layout+" "+release.Path, func(t *testing.T) {
			ctx := context.Background()
			narsil := openEarlierRelease(t, ctx, release, t.TempDir())
			for indexName, expectedPath := range release.Indexes {
				var expected map[string]json.RawMessage
				readJSONFile(t, samplesPath(expectedPath), &expected)
				for id, written := range expected {
					stored, found, err := narsil.Get(ctx, indexName, id)
					if err != nil || !found {
						t.Fatalf("%s lost document %q: found %t with %s", indexName, id, found, codeOrMessage(err))
					}
					encoded, err := json.Marshal(stored)
					if err != nil {
						t.Fatalf("json.Marshal of document %q failed: %v", id, err)
					}
					want, got := jsonKeyPaths(t, written), withoutTopLevelID(jsonKeyPaths(t, encoded))
					if !slices.Equal(want, got) {
						t.Fatalf("document %q of %s holds its keys in the order %v, while the earlier release wrote %v",
							id, indexName, got, want)
					}
				}
			}
		})
	}
}

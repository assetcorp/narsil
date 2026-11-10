package engine_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const maxExportLineBytes = 64 << 20

func conformancePath(parts ...string) string {
	return filepath.Join(append([]string{"..", "..", "conformance"}, parts...)...)
}

func samplesPath(parts ...string) string {
	return conformancePath(append([]string{"samples"}, parts...)...)
}

func readJSONFile(t *testing.T, path string, into any) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s failed: %v", path, err)
	}
	if err := json.Unmarshal(data, into); err != nil {
		t.Fatalf("%s holds JSON that does not parse: %v", path, err)
	}
}

func decodedJSON(data []byte) (any, error) {
	var value any
	err := json.Unmarshal(data, &value)
	return value, err
}

func describeJSON(value any) string {
	if value == nil {
		return "nothing"
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprintf("%v", value)
	}
	if len(encoded) > 300 {
		return string(encoded[:300]) + "..."
	}
	return string(encoded)
}

func at(path string) string {
	if path == "" {
		return "(root)"
	}
	return path
}

func contentDifference(expected any, actual any, path string, signedZero bool) string {
	switch want := expected.(type) {
	case float64:
		got, isNumber := actual.(float64)
		if isNumber && want == got && (!signedZero || math.Signbit(want) == math.Signbit(got)) {
			return ""
		}
	case []any:
		got, isList := actual.([]any)
		if !isList {
			break
		}
		if len(want) != len(got) {
			return fmt.Sprintf("%s: expected %d items, found %d", at(path), len(want), len(got))
		}
		for index := range want {
			if difference := contentDifference(want[index], got[index], fmt.Sprintf("%s[%d]", path, index), signedZero); difference != "" {
				return difference
			}
		}
		return ""
	case map[string]any:
		got, isObject := actual.(map[string]any)
		if !isObject {
			break
		}
		keys := map[string]struct{}{}
		for key := range want {
			keys[key] = struct{}{}
		}
		for key := range got {
			keys[key] = struct{}{}
		}
		ordered := make([]string, 0, len(keys))
		for key := range keys {
			ordered = append(ordered, key)
		}
		sort.Strings(ordered)
		for _, key := range ordered {
			child := key
			if path != "" {
				child = path + "." + key
			}
			wanted, wantHeld := want[key]
			found, gotHeld := got[key]
			if wantHeld != gotHeld {
				return fmt.Sprintf("%s: expected %s, found %s", child, describeJSON(wanted), describeJSON(found))
			}
			if difference := contentDifference(wanted, found, child, signedZero); difference != "" {
				return difference
			}
		}
		return ""
	default:
		if expected == actual {
			return ""
		}
	}
	return fmt.Sprintf("%s: expected %s, found %s", at(path), describeJSON(expected), describeJSON(actual))
}

func copyTree(t *testing.T, source string, target string) {
	t.Helper()
	err := filepath.WalkDir(source, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		destination := filepath.Join(target, relative)
		if entry.IsDir() {
			return os.MkdirAll(destination, 0o755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(destination, data, 0o644)
	})
	if err != nil {
		t.Fatalf("copying %s to %s failed: %v", source, target, err)
	}
}

func overlayFile(t *testing.T, source string, target string) {
	t.Helper()
	data, err := os.ReadFile(source)
	if err != nil {
		t.Fatalf("reading %s failed: %v", source, err)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatalf("creating the directory of %s failed: %v", target, err)
	}
	if err := os.WriteFile(target, data, 0o644); err != nil {
		t.Fatalf("writing %s failed: %v", target, err)
	}
}

func exportedDocuments(ctx context.Context, narsil *engine.Narsil, indexName string) (map[string]any, error) {
	var buffer bytes.Buffer
	if err := narsil.ExportDocuments(ctx, indexName, &buffer); err != nil {
		return nil, err
	}
	scanner := bufio.NewScanner(&buffer)
	scanner.Buffer(make([]byte, 0, 1<<16), maxExportLineBytes)
	documents := map[string]any{}
	for line := 0; scanner.Scan(); line++ {
		text := strings.TrimSpace(scanner.Text())
		if line == 0 || text == "" {
			continue
		}
		parsed, err := decodedJSON([]byte(text))
		if err != nil {
			return nil, fmt.Errorf("line %d of the export of %s does not parse: %w", line+1, indexName, err)
		}
		document, isObject := parsed.(map[string]any)
		id, hasID := document["id"].(string)
		if !isObject || !hasID {
			return nil, fmt.Errorf("line %d of the export of %s holds no string id", line+1, indexName)
		}
		delete(document, "id")
		documents[id] = document
	}
	return documents, scanner.Err()
}

func codeOrMessage(err error) string {
	if err == nil {
		return ""
	}
	if code := engine.ErrorCode(err); code != "" {
		return code
	}
	return "an untyped error: " + err.Error()
}

package engine_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

const nodeScriptDeadline = 10 * time.Minute

func typeScriptEngineEntry() string {
	return filepath.Join("..", "..", "ts", "dist", "index.mjs")
}

func requireTypeScriptEngine(t *testing.T) string {
	t.Helper()
	if _, err := os.Stat(typeScriptEngineEntry()); errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("%s is missing, so the TypeScript engine cannot open what Go saves; build it with `pnpm nx run narsil-ts:build:code` from the repository root",
			typeScriptEngineEntry())
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatalf("node is not on PATH, so the TypeScript engine cannot run: %v", err)
	}
	return node
}

func writeJSONFile(t *testing.T, path string, value any) {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("encoding %s failed: %v", path, err)
	}
	if err := os.WriteFile(path, encoded, 0o644); err != nil {
		t.Fatalf("writing %s failed: %v", path, err)
	}
}

func runTypeScriptEngine(t *testing.T, request map[string]any) {
	t.Helper()
	node := requireTypeScriptEngine(t)
	requestPath := filepath.Join(t.TempDir(), "request.json")
	writeJSONFile(t, requestPath, request)
	ctx, cancel := context.WithTimeout(context.Background(), nodeScriptDeadline)
	defer cancel()
	command := exec.CommandContext(ctx, node, filepath.Join("testdata", "narsil-ts.mjs"), requestPath)
	var output bytes.Buffer
	command.Stdout = &output
	command.Stderr = &output
	if err := command.Run(); err != nil {
		t.Fatalf("the TypeScript engine failed in %s mode: %v\n%s", request["mode"], err, output.String())
	}
}

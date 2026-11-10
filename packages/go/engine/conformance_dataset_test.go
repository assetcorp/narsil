package engine_test

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

const (
	artifactManifestName      = "artifact.json"
	fetchedMarkerName         = "fetched.json"
	datasetDocumentsName      = "documents.jsonl.gz"
	datasetVectorsName        = "vectors.f32"
	datasetQueriesName        = "queries.json"
	datasetDocumentCount      = 10_000
	datasetVectorDimension    = 384
	maxArtifactManifestBytes  = 1 << 20
	maxArtifactFileBytes      = 256 << 20
	datasetDownloadAttempts   = 8
	datasetRetryDelay         = 3 * time.Second
	datasetRequestTimeout     = 120 * time.Second
	maxDatasetDocumentLineLen = 4 << 20
)

var (
	sha256Pattern   = regexp.MustCompile(`^[0-9a-f]{64}$`)
	safeNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)
	retriedStatuses = map[int]bool{408: true, 425: true, 429: true, 500: true, 502: true, 503: true, 504: true}
)

type datasetPin struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
}

type artifactFile struct {
	Path   string `json:"path"`
	Asset  string `json:"asset"`
	SHA256 string `json:"sha256"`
	Bytes  int64  `json:"bytes"`
}

type billDocument struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Summary string `json:"summary"`
}

type datasetQueries struct {
	TextQueries []struct {
		ID   string `json:"id"`
		Text string `json:"text"`
	} `json:"textQueries"`
	VectorQueries []struct {
		ID     string    `json:"id"`
		Text   string    `json:"text"`
		Vector []float64 `json:"vector"`
	} `json:"vectorQueries"`
}

type conformanceDataset struct {
	documents []billDocument
	vectors   []float32
	queries   datasetQueries
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func artifactFilesOf(manifestData []byte) ([]artifactFile, error) {
	var manifest struct {
		Format    string         `json:"format"`
		DatasetID string         `json:"dataset_id"`
		Files     []artifactFile `json:"files"`
	}
	if err := json.Unmarshal(manifestData, &manifest); err != nil {
		return nil, err
	}
	if manifest.Format != "narsil-conformance-dataset/1" || manifest.DatasetID != "conformance/billsum-us" || len(manifest.Files) == 0 {
		return nil, errors.New("the artifact manifest names another format or dataset, or lists no file")
	}
	seen := map[string]bool{}
	for _, file := range manifest.Files {
		if !safeNamePattern.MatchString(file.Path) || !safeNamePattern.MatchString(file.Asset) || !sha256Pattern.MatchString(file.SHA256) ||
			file.Bytes < 0 || file.Bytes > maxArtifactFileBytes || seen[file.Path] || file.Path == artifactManifestName || file.Path == fetchedMarkerName {
			return nil, fmt.Errorf("the artifact manifest lists a file it must refuse: %+v", file)
		}
		seen[file.Path] = true
	}
	return manifest.Files, nil
}

func fileMatches(path string, file artifactFile) bool {
	data, err := os.ReadFile(path)
	return err == nil && int64(len(data)) == file.Bytes && sha256Hex(data) == file.SHA256
}

func fetchOnce(ctx context.Context, url string, limit int64) ([]byte, bool, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, false, err
	}
	request.Header.Set("User-Agent", "narsil-conformance-suite")
	response, err := (&http.Client{Timeout: datasetRequestTimeout}).Do(request)
	if err != nil {
		return nil, true, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, retriedStatuses[response.StatusCode], fmt.Errorf("%s answered %d", url, response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, true, err
	}
	if int64(len(data)) > limit {
		return nil, false, fmt.Errorf("%s sent more than %d bytes", url, limit)
	}
	return data, false, nil
}

func fetchBytes(ctx context.Context, url string, limit int64) ([]byte, error) {
	for attempt := 1; ; attempt++ {
		data, retry, err := fetchOnce(ctx, url, limit)
		if err == nil || !retry || attempt >= datasetDownloadAttempts {
			return data, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(datasetRetryDelay * time.Duration(attempt)):
		}
	}
}

func writeAtomically(path string, data []byte) error {
	partial := path + ".part"
	if err := os.WriteFile(partial, data, 0o644); err != nil {
		return err
	}
	return os.Rename(partial, path)
}

func verifiedDatasetDirectory(directory string, pin datasetPin) bool {
	marker, err := os.ReadFile(filepath.Join(directory, fetchedMarkerName))
	if err != nil || strings.TrimSpace(string(marker)) != pin.SHA256 {
		return false
	}
	manifestData, err := os.ReadFile(filepath.Join(directory, artifactManifestName))
	if err != nil || sha256Hex(manifestData) != pin.SHA256 {
		return false
	}
	files, err := artifactFilesOf(manifestData)
	if err != nil {
		return false
	}
	for _, file := range files {
		if !fileMatches(filepath.Join(directory, file.Path), file) {
			return false
		}
	}
	return true
}

func fetchPinnedDataset(t *testing.T) string {
	t.Helper()
	var pin datasetPin
	readJSONFile(t, conformancePath("dataset-pin.json"), &pin)
	if !strings.HasPrefix(pin.URL, "https://") || !sha256Pattern.MatchString(pin.SHA256) {
		t.Fatalf("dataset-pin.json holds a pin the suite must refuse: %+v", pin)
	}
	directory := conformancePath(".dataset")
	if verifiedDatasetDirectory(directory, pin) {
		return directory
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	if err := os.MkdirAll(directory, 0o755); err != nil {
		t.Fatalf("creating %s failed: %v", directory, err)
	}
	_ = os.Remove(filepath.Join(directory, fetchedMarkerName))
	manifestData, err := fetchBytes(ctx, pin.URL+"/"+artifactManifestName, maxArtifactManifestBytes)
	if err != nil {
		t.Fatalf("fetching the dataset manifest failed: %v", err)
	}
	if digest := sha256Hex(manifestData); digest != pin.SHA256 {
		t.Fatalf("the published dataset manifest has SHA-256 %s, while the pin gives %s", digest, pin.SHA256)
	}
	files, err := artifactFilesOf(manifestData)
	if err != nil {
		t.Fatalf("the published dataset manifest is not usable: %v", err)
	}
	for _, file := range files {
		target := filepath.Join(directory, file.Path)
		if fileMatches(target, file) {
			continue
		}
		data, err := fetchBytes(ctx, pin.URL+"/"+file.Asset, file.Bytes)
		if err != nil {
			t.Fatalf("fetching %s failed: %v", file.Asset, err)
		}
		if int64(len(data)) != file.Bytes || sha256Hex(data) != file.SHA256 {
			t.Fatalf("the published %s differs from the SHA-256 that the artifact manifest lists", file.Asset)
		}
		if err := writeAtomically(target, data); err != nil {
			t.Fatalf("storing %s failed: %v", target, err)
		}
	}
	if err := writeAtomically(filepath.Join(directory, artifactManifestName), manifestData); err != nil {
		t.Fatalf("storing the dataset manifest failed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(directory, fetchedMarkerName), []byte(pin.SHA256+"\n"), 0o644); err != nil {
		t.Fatalf("marking the dataset fetched failed: %v", err)
	}
	return directory
}

func loadConformanceDataset(t *testing.T, directory string) conformanceDataset {
	t.Helper()
	compressed, err := os.ReadFile(filepath.Join(directory, datasetDocumentsName))
	if err != nil {
		t.Fatalf("reading the dataset documents failed: %v", err)
	}
	unzipped, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		t.Fatalf("the dataset documents are not gzip: %v", err)
	}
	scanner := bufio.NewScanner(unzipped)
	scanner.Buffer(make([]byte, 0, 1<<16), maxDatasetDocumentLineLen)
	dataset := conformanceDataset{}
	seen := map[string]bool{}
	for scanner.Scan() {
		var document billDocument
		if err := json.Unmarshal(scanner.Bytes(), &document); err != nil || document.ID == "" || seen[document.ID] {
			t.Fatalf("line %d of the dataset documents is not a new bill: %v", len(dataset.documents)+1, err)
		}
		seen[document.ID] = true
		dataset.documents = append(dataset.documents, document)
	}
	if err := scanner.Err(); err != nil || len(dataset.documents) != datasetDocumentCount {
		t.Fatalf("the dataset holds %d documents, not %d: %v", len(dataset.documents), datasetDocumentCount, err)
	}
	raw, err := os.ReadFile(filepath.Join(directory, datasetVectorsName))
	if err != nil || len(raw) != datasetDocumentCount*datasetVectorDimension*4 {
		t.Fatalf("the dataset vectors hold %d bytes: %v", len(raw), err)
	}
	dataset.vectors = make([]float32, len(raw)/4)
	for component := range dataset.vectors {
		value := math.Float32frombits(binary.LittleEndian.Uint32(raw[component*4:]))
		if math.IsNaN(float64(value)) || math.IsInf(float64(value), 0) {
			t.Fatalf("the dataset vectors hold a component that is not finite at %d", component)
		}
		dataset.vectors[component] = value
	}
	readJSONFile(t, filepath.Join(directory, datasetQueriesName), &dataset.queries)
	for _, query := range dataset.queries.VectorQueries {
		if len(query.Vector) != datasetVectorDimension {
			t.Fatalf("the vector query %s holds %d components", query.ID, len(query.Vector))
		}
	}
	return dataset
}

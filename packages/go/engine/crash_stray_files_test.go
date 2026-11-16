package engine_test

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	envelopeHeaderBytes      = 32
	envelopeMagic            = "NRSL"
	envelopeCompressedFlag   = 1
	envelopeGzipAlgorithm    = 1
	temporaryFileMarker      = ".tmp-"
	checkpointSegmentsFolder = "segments"
)

func manifestPayloadAt(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if len(data) < envelopeHeaderBytes || string(data[:4]) != envelopeMagic {
		return nil, fmt.Errorf("%s holds no .nrsl envelope", path)
	}
	length := int(binary.BigEndian.Uint32(data[8:12]))
	flags := binary.BigEndian.Uint16(data[12:14])
	if envelopeHeaderBytes+length > len(data) {
		return nil, fmt.Errorf("%s is shorter than its header says", path)
	}
	payload := data[envelopeHeaderBytes : envelopeHeaderBytes+length]
	if flags&envelopeCompressedFlag == 0 {
		return payload, nil
	}
	if (flags>>1)&3 != envelopeGzipAlgorithm {
		return nil, fmt.Errorf("%s names a compression other than gzip", path)
	}
	reader, err := gzip.NewReader(bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	return io.ReadAll(reader)
}

func strayFiles(directory string, indexName string) ([]string, error) {
	listed, err := manifestPayloadAt(filepath.Join(directory, indexName, "manifest"))
	if err != nil {
		return nil, err
	}
	var stray []string
	err = filepath.WalkDir(directory, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if entry.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(directory, path)
		if err != nil {
			return err
		}
		key := filepath.ToSlash(relative)
		inSegments := strings.HasPrefix(key, indexName+"/"+checkpointSegmentsFolder+"/")
		if strings.Contains(entry.Name(), temporaryFileMarker) || (inSegments && !bytes.Contains(listed, []byte(key))) {
			stray = append(stray, key)
		}
		return nil
	})
	return stray, err
}

func requireNoStrayFiles(t *testing.T, directory string, indexName string, moment string) {
	t.Helper()
	stray, err := strayFiles(directory, indexName)
	if err != nil {
		t.Fatalf("%s, listing the durability directory failed: %v", moment, err)
	}
	if len(stray) > 0 {
		t.Fatalf("%s, the directory holds %d files that no manifest lists, such as %v", moment, len(stray),
			stray[:min(len(stray), 5)])
	}
}

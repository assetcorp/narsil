package engine_test

import (
	"bytes"
	"errors"
	"io"
	"regexp"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/archive"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/indexconfig"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/paged"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector/payload"
)

const (
	keywordSegmentEnvelopeVersion = 4
	pagedSegmentEnvelopeVersion   = 6
	envelopeVersionOffset         = 4
)

var (
	archivedSegmentEntry   = regexp.MustCompile(`^segments/\d+/s\d{16}$`)
	archivedGraphPartEntry = regexp.MustCompile(`^segments/vec-.+-graph-g\d+-p\d{16}$`)
	archivedVectorEntry    = regexp.MustCompile(`^segments/vec-.+-f\d{16}$`)
)

func vectorStorageOfConfig(config map[string]any) string {
	payloadValue, _ := config["payload"].(map[string]any)
	promotion, _ := payloadValue["vectorPromotion"].(map[string]any)
	if promotion["storage"] == "disk" {
		return "disk"
	}
	return "memory"
}

func archiveEntryForm(name string, data []byte, storage string, what string) (map[string]any, error) {
	switch {
	case archivedSegmentEntry.MatchString(name):
		if len(data) <= envelopeVersionOffset {
			return nil, errors.New(what + " is too short to hold an envelope")
		}
		switch data[envelopeVersionOffset] {
		case keywordSegmentEnvelopeVersion:
			return keywordForm(data)
		case pagedSegmentEnvelopeVersion:
			return paged.FormOfBytes(data)
		}
		return nil, errors.New(what + " holds envelope version " + strconv.Itoa(int(data[envelopeVersionOffset])))
	case archivedGraphPartEntry.MatchString(name):
		return payload.GraphPartFormOf(data, storage, what)
	case archivedVectorEntry.MatchString(name):
		return payload.VectorFileFormOf(data, storage, what)
	}
	return nil, errors.New(what + " holds an entry named " + name)
}

func archiveEntryBytes(name string, content map[string]any, what string) (payload.Written, error) {
	switch {
	case archivedSegmentEntry.MatchString(name):
		header, _ := content["header"].(map[string]any)
		var data []byte
		var err error
		if version, _ := header["envelopeFormatVersion"].(float64); version == pagedSegmentEnvelopeVersion {
			data, err = paged.PackForm(content)
		} else {
			data, err = keywordBytes(content)
		}
		return payload.Written{Bytes: data}, err
	case archivedGraphPartEntry.MatchString(name):
		return payload.PackGraphPartForm(content, what)
	case archivedVectorEntry.MatchString(name):
		return payload.PackVectorFileForm(content, what)
	}
	return payload.Written{}, errors.New(what + " holds an entry named " + name)
}

func fillListedRef(ref *manifest.FileRef, written payload.Written) error {
	if err := manifest.FillFile(ref, written.Bytes); err != nil {
		return err
	}
	if written.HasHead {
		ref.Head = model.Some(manifest.Head{Offset: uint64(written.HeadOffset), Length: uint32(written.HeadLength),
			Checksum: written.HeadChecksum})
	}
	return nil
}

func listedArchiveFiles(manifestData []byte) ([]archive.ListedFile, error) {
	opened, err := manifest.Open(manifestData)
	if err != nil {
		return nil, err
	}
	name, err := manifest.SourceIndexName(manifest.ListedKeys(opened.Payload))
	if err != nil {
		return nil, err
	}
	listed, err := manifest.FromPayload(opened.Payload, name)
	if err != nil {
		return nil, err
	}
	files := []archive.ListedFile{}
	for _, ref := range listed.Files() {
		files = append(files, archive.ListedFile{Name: ref.Key[len(name)+1:], Bytes: int64(ref.Bytes), Checksum: ref.Checksum})
	}
	return files, nil
}

func archiveForm(data []byte, what string) (map[string]any, error) {
	entries := []any{}
	storage := "memory"
	err := archive.Read(bytes.NewReader(data), archive.Handlers{
		Config: func(config []byte) error {
			raw, err := indexconfig.ReadForm(config)
			if err != nil {
				return err
			}
			value, err := form.Decode(raw)
			if err != nil {
				return err
			}
			storage = vectorStorageOfConfig(value)
			entries = append(entries, map[string]any{"name": "config", "content": value})
			return nil
		},
		Manifest: func(manifestData []byte) ([]archive.ListedFile, error) {
			value, err := manifestForm(manifestData, true)
			if err != nil {
				return nil, err
			}
			entries = append(entries, map[string]any{"name": "manifest", "content": value})
			return listedArchiveFiles(manifestData)
		},
		File: func(file archive.ListedFile, body io.Reader) error {
			content, err := io.ReadAll(io.LimitReader(body, file.Bytes))
			if err != nil {
				return err
			}
			value, err := archiveEntryForm(file.Name, content, storage, what+" "+file.Name)
			if err != nil {
				return err
			}
			entries = append(entries, map[string]any{"name": file.Name, "content": value})
			return nil
		},
		History: func(int, io.Reader) error { return nil },
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"entries": entries}, nil
}

func archiveEntryAt(list []any, position int) (string, map[string]any) {
	record, _ := list[position].(map[string]any)
	name, _ := record["name"].(string)
	content, _ := record["content"].(map[string]any)
	return name, content
}

func archiveBytes(value map[string]any, what string) ([]byte, error) {
	list, _ := value["entries"].([]any)
	if len(list) < 2 {
		return nil, errors.New(what + " lists fewer than two entries")
	}
	_, configContent := archiveEntryAt(list, 0)
	raw, err := form.Encode(configContent)
	if err != nil {
		return nil, err
	}
	config, err := indexconfig.WriteForm(raw)
	if err != nil {
		return nil, err
	}
	_, manifestContent := archiveEntryAt(list, 1)
	header, listed, err := manifest.FromJSON(manifestContent, true)
	if err != nil {
		return nil, err
	}
	manifestPayload, _ := manifestContent["payload"].(map[string]any)
	indexName, err := manifest.SourceIndexName(manifest.ListedKeys(manifestPayload))
	if err != nil {
		return nil, err
	}
	refs := map[string]*manifest.FileRef{}
	for _, ref := range listed.Files() {
		refs[ref.Key] = ref
	}
	names := make([]string, 0, len(list)-2)
	files := make([][]byte, 0, len(list)-2)
	for position := 2; position < len(list); position++ {
		name, content := archiveEntryAt(list, position)
		written, err := archiveEntryBytes(name, content, what+" "+name)
		if err != nil {
			return nil, err
		}
		ref, listedRef := refs[indexName+"/"+name]
		if !listedRef {
			return nil, errors.New(what + " holds " + name + ", which its manifest leaves out")
		}
		if err := fillListedRef(ref, written); err != nil {
			return nil, err
		}
		names = append(names, name)
		files = append(files, written.Bytes)
	}
	manifestData, err := manifest.Encode(listed, indexName, header.Gzip)
	if err != nil {
		return nil, err
	}
	var buffer bytes.Buffer
	writer := archive.NewWriter(&buffer)
	if err := writer.WriteConfig(config); err != nil {
		return nil, err
	}
	if err := writer.WriteManifest(manifestData); err != nil {
		return nil, err
	}
	for position, name := range names {
		if err := writer.WriteFile(name, int64(len(files[position])), bytes.NewReader(files[position])); err != nil {
			return nil, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

package engine_test

import (
	"bytes"
	"errors"
	"path"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/backup"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/commitmarker"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/export"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/indexconfig"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/metadata"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/paged"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/wal"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector/payload"
)

func encodedForm(value map[string]any, err error) ([]byte, error) {
	if err != nil {
		return nil, err
	}
	return form.Encode(value)
}

func backupNameOf(data []byte, fallback string) string {
	opened, err := envelope.OpenChecksummed(data, envelope.Kind{FormatVersion: backup.FormatVersion, What: "backup manifest"})
	if err != nil {
		return fallback
	}
	decoded, err := codec.Unmarshal(opened.Payload, codec.DecodeOptions{ErrorCode: narsilerr.CodeBackupDamaged})
	if err != nil {
		return fallback
	}
	record, _ := decoded.(map[string]any)
	if name, isName := record["name"].(string); isName {
		return name
	}
	return fallback
}

func manifestForm(data []byte, inArchive bool) (map[string]any, error) {
	opened, err := manifest.Open(data)
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
	return manifest.JSONValue(form.HeaderOf(opened.Header), listed, inArchive), nil
}

func manifestBytes(value map[string]any, inArchive bool) ([]byte, error) {
	header, listed, err := manifest.FromJSON(value, inArchive)
	if err != nil {
		return nil, err
	}
	raw, _ := value["payload"].(map[string]any)
	name, err := manifest.SourceIndexName(manifest.ListedKeys(raw))
	if err != nil {
		return nil, err
	}
	return manifest.Encode(listed, name, header.Gzip)
}

func keywordForm(data []byte) (map[string]any, error) {
	file, err := keyword.Open(data)
	if err != nil {
		return nil, err
	}
	return keyword.FormOf(file)
}

func keywordBytes(value map[string]any) ([]byte, error) {
	header, segment, err := keyword.FromForm(value)
	if err != nil {
		return nil, err
	}
	return keyword.Pack(segment, header.Gzip)
}

func readSampleForm(kind string, data []byte, storage string, name string) ([]byte, error) {
	switch kind {
	case "log-segment":
		segment, err := wal.DecodeSegment(data)
		if err != nil {
			return nil, err
		}
		return encodedForm(segment.JSONValue())
	case "commit-marker":
		return form.Encode(commitmarker.Decode(data).JSONValue())
	case "manifest":
		return encodedForm(manifestForm(data, false))
	case "keyword-segment":
		return encodedForm(keywordForm(data))
	case "paged-segment":
		return encodedForm(paged.FormOfBytes(data))
	case "vector-file":
		return encodedForm(payload.VectorFileFormOf(data, storage, name))
	case "graph-part":
		return encodedForm(payload.GraphPartFormOf(data, storage, name))
	case "index-metadata":
		return metadata.ReadForm(data)
	case "index-configuration":
		return indexconfig.ReadForm(data)
	case "backup-manifest":
		return backup.ReadForm(data, backupNameOf(data, path.Base(name)))
	case "snapshot-archive":
		return encodedForm(archiveForm(data, name))
	case "document-export":
		parsed, err := export.ReadForm(bytes.NewReader(data))
		if err != nil {
			return nil, err
		}
		return parsed.Encode()
	}
	return nil, errors.New("the suite lists an unknown kind " + kind)
}

func writeSampleForm(kind string, data []byte, name string) ([]byte, error) {
	switch kind {
	case "index-metadata":
		return metadata.WriteForm(data)
	case "index-configuration":
		return indexconfig.WriteForm(data)
	case "backup-manifest":
		return backup.WriteForm(data)
	case "document-export":
		parsed, err := export.DecodeForm(data)
		if err != nil {
			return nil, err
		}
		var buffer bytes.Buffer
		err = export.WriteForm(&buffer, parsed)
		return buffer.Bytes(), err
	}
	value, err := form.Decode(data)
	if err != nil {
		return nil, err
	}
	switch kind {
	case "log-segment":
		segment, err := wal.SegmentFromJSON(value)
		if err != nil {
			return nil, err
		}
		return wal.EncodeSegment(segment)
	case "commit-marker":
		marker, err := commitmarker.FromJSON(value)
		if err != nil {
			return nil, err
		}
		return commitmarker.Encode(marker)
	case "manifest":
		return manifestBytes(value, false)
	case "keyword-segment":
		return keywordBytes(value)
	case "paged-segment":
		return paged.PackForm(value)
	case "vector-file":
		written, err := payload.PackVectorFileForm(value, name)
		return written.Bytes, err
	case "graph-part":
		written, err := payload.PackGraphPartForm(value, name)
		return written.Bytes, err
	case "snapshot-archive":
		return archiveBytes(value, name)
	}
	return nil, errors.New("the suite lists an unknown kind " + kind)
}

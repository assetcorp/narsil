package manifest

import (
	"maps"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

func JSONValue(header form.HeaderForm, manifest Manifest, inArchive bool) map[string]any {
	mode := treeJSON
	if inArchive {
		mode = treeArchiveJSON
	}
	return map[string]any{"header": header.Value(), "payload": manifest.tree(mode)}
}

func ListedKeys(payload map[string]any) []string {
	var keys []string
	collect := func(list any, listKey string) {
		entries, _ := list.([]any)
		for _, element := range entries {
			record, _ := element.(map[string]any)
			refs, _ := record[listKey].([]any)
			for _, ref := range refs {
				refRecord, _ := ref.(map[string]any)
				if key, isString := refRecord["key"].(string); isString {
					keys = append(keys, key)
				}
			}
		}
	}
	collect(payload["partitions"], "segments")
	vectors, _ := payload["vectors"].([]any)
	for _, field := range vectors {
		collect([]any{field}, "files")
		collect([]any{field}, "graphParts")
	}
	return keys
}

func deadFromJSON(payload map[string]any, fields *form.Fields) map[string]any {
	vectors, isList := payload["vectors"].([]any)
	if !isList {
		return payload
	}
	converted := maps.Clone(payload)
	convertedVectors := make([]any, len(vectors))
	for fieldIndex, field := range vectors {
		record, isMap := field.(map[string]any)
		files, hasFiles := record["files"].([]any)
		if !isMap || !hasFiles {
			convertedVectors[fieldIndex] = field
			continue
		}
		convertedFiles := make([]any, len(files))
		for fileIndex, file := range files {
			fileRecord, isFileMap := file.(map[string]any)
			dead, isDeadList := fileRecord["dead"].([]any)
			if !isFileMap || !isDeadList {
				convertedFiles[fileIndex] = file
				continue
			}
			copied := maps.Clone(fileRecord)
			path := "payload.vectors[" + strconv.Itoa(fieldIndex) + "].files[" + strconv.Itoa(fileIndex) + "].dead"
			copied["dead"] = fields.NumberBytesAt(dead, path, form.WidthUint8)
			convertedFiles[fileIndex] = copied
		}
		copiedField := maps.Clone(record)
		copiedField["files"] = convertedFiles
		convertedVectors[fieldIndex] = copiedField
	}
	converted["vectors"] = convertedVectors
	return converted
}

func FromJSON(value map[string]any, inArchive bool) (form.HeaderForm, Manifest, error) {
	fields := form.NewFields(value, "", form.CodeJSONForm, "manifest JSON form")
	header := form.HeaderFrom(fields.Object("header"))
	payload, _ := value["payload"].(map[string]any)
	if payload == nil {
		fields.Fail("payload", "is not a map")
	}
	if fields.Err() != nil {
		return form.HeaderForm{}, Manifest{}, fields.Err()
	}
	if version, _ := payload["version"].(float64); version != Version {
		return form.HeaderForm{}, Manifest{}, narsilerr.New(form.CodeJSONForm,
			"The manifest JSON form holds a version other than "+strconv.Itoa(Version), nil)
	}
	payload = deadFromJSON(payload, fields)
	if fields.Err() != nil {
		return form.HeaderForm{}, Manifest{}, fields.Err()
	}
	indexName, err := SourceIndexName(ListedKeys(payload))
	if err != nil {
		return form.HeaderForm{}, Manifest{}, err
	}
	decoded, err := readManifest(payload, readMode{indexName: indexName, placement: !inArchive, code: form.CodeJSONForm})
	return header, decoded, err
}

func FillFile(ref *FileRef, file []byte) error {
	checksum, present := envelope.ChecksumBytesOf(file)
	if !present {
		return narsilerr.New(narsilerr.CodePersistenceSaveFailed,
			"The file \""+ref.Key+"\" is shorter than its .nrsl header", map[string]any{"key": ref.Key})
	}
	ref.Bytes = uint64(len(file))
	ref.Checksum = checksum
	return nil
}

func RequireListedFile(ref FileRef, length int64, headerChecksum uint32, what string) error {
	if length < 0 || uint64(length) != ref.Bytes {
		return narsilerr.New(narsilerr.CodePersistenceLoadFailed,
			"The "+what+" \""+ref.Key+"\" holds "+strconv.FormatInt(length, 10)+" bytes where the manifest lists "+
				strconv.FormatUint(ref.Bytes, 10), map[string]any{"key": ref.Key, "bytes": length, "listed": ref.Bytes})
	}
	if headerChecksum != ref.Checksum {
		return narsilerr.New(narsilerr.CodePersistenceLoadFailed,
			"The "+what+" \""+ref.Key+"\" carries the checksum "+strconv.FormatUint(uint64(headerChecksum), 10)+
				" where the manifest lists "+strconv.FormatUint(uint64(ref.Checksum), 10),
			map[string]any{"key": ref.Key, "checksum": headerChecksum, "listed": ref.Checksum})
	}
	return nil
}

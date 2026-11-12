package persist

import (
	"bytes"
	"context"
	"io"
	"math"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/paged"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/storage"
)

const (
	float64Bytes               = 8
	codesKeyAndMapHeaderBytes  = 7
	binaryEightMaxBytes        = 0xff
	binarySixteenMaxBytes      = 0xffff
	codesValueCount            = 4
	uint32Bytes                = 4
	coldGraphLayoutsPerPartRef = 1
)

var (
	vectorPageSizes    = []int64{paged.SegmentPageBytes, paged.RecordPageBytes}
	neighbourPageSizes = []int64{paged.RecordPageBytes}
	levelPageSizes     = []int64{paged.SegmentPageBytes}
)

type coldSource struct {
	reader io.ReaderAt
	size   int64
	close  func()
}

func coldLoadFailed(message string, key string) error {
	return narsilerr.New(narsilerr.CodePersistenceLoadFailed, message, map[string]any{"key": key})
}

func openColdSource(ctx context.Context, store checkpoint.Store, ref manifest.FileRef) (coldSource, error) {
	if path, located := store.PathOf(ref.Key); located {
		file, err := storage.OpenForReading(path)
		if err != nil {
			return coldSource{}, narsilerr.Wrap(narsilerr.CodePersistenceLoadFailed,
				`The file "`+ref.Key+`" cannot be opened`, err, map[string]any{"key": ref.Key})
		}
		native, err := paged.OpenNativeFile(file, path)
		if err != nil {
			return coldSource{}, err
		}
		return coldSource{reader: native, size: native.Size(), close: func() { _ = native.Close() }}, nil
	}
	data, err := checkpoint.ReadListed(ctx, store, ref, "file")
	if err != nil {
		return coldSource{}, err
	}
	return coldSource{reader: bytes.NewReader(data), size: int64(len(data)), close: func() {}}, nil
}

func readColdRange(source coldSource, offset int64, length int64, key string) ([]byte, error) {
	if offset < 0 || length < 0 || offset+length > source.size {
		return nil, coldLoadFailed(`The file "`+key+`" ends before byte `+strconv.FormatInt(offset+length, 10), key)
	}
	data := make([]byte, length)
	read, err := source.reader.ReadAt(data, offset)
	if read != len(data) {
		return nil, narsilerr.Wrap(narsilerr.CodePersistenceLoadFailed, `The file "`+key+`" cannot be read`, err,
			map[string]any{"key": key})
	}
	return data, nil
}

func coldHead(source coldSource, ref manifest.FileRef) (map[string]any, bool, error) {
	head, present := ref.Head.Get()
	if !present || source.size < envelope.HeaderBytes {
		return nil, false, nil
	}
	start, err := readColdRange(source, 0, envelope.HeaderBytes, ref.Key)
	if err != nil {
		return nil, false, err
	}
	header, err := envelope.ParseHeader(start)
	if err != nil || header.Compressed() {
		return nil, false, nil
	}
	encoded, err := readColdRange(source, envelope.HeaderBytes+int64(head.Offset), int64(head.Length), ref.Key)
	if err != nil {
		return nil, false, err
	}
	if codec.CRC32(encoded) != head.Checksum {
		return nil, false, narsilerr.New(narsilerr.CodePersistenceCrcMismatch,
			`The head of the file "`+ref.Key+`" does not match its checksum`, map[string]any{"key": ref.Key})
	}
	decoded, err := codec.Unmarshal(encoded, codec.DecodeOptions{ErrorCode: narsilerr.CodePersistenceLoadFailed})
	if err != nil {
		return nil, false, narsilerr.Wrap(narsilerr.CodePersistenceLoadFailed,
			`The head of "`+ref.Key+`" is not MessagePack`, err, map[string]any{"key": ref.Key})
	}
	entry, isMap := decoded.(map[string]any)
	if !isMap {
		return nil, false, coldLoadFailed(`The head of "`+ref.Key+`" is not a map`, ref.Key)
	}
	return entry, true, nil
}

func binaryHeaderBytes(length int64) int64 {
	if length <= binaryEightMaxBytes {
		return 2
	}
	if length <= binarySixteenMaxBytes {
		return 3
	}
	return 5
}

type coldCodes struct {
	bits     uint32
	centroid []float32
}

func coldCodesOf(source coldSource, sections map[string]paged.Section, key string) (*coldCodes, error) {
	records, holdsRecords := sections["records"]
	ids, holdsIDs := sections["docIds"]
	if !holdsRecords || !holdsIDs {
		return nil, nil
	}
	start := ids.Offset + ids.Length
	length := records.Offset - start - binaryHeaderBytes(records.Length)
	if length <= codesKeyAndMapHeaderBytes {
		return nil, coldLoadFailed(`The file "`+key+`" places its codes before its IDs`, key)
	}
	raw, err := readColdRange(source, envelope.HeaderBytes+start, length, key)
	if err != nil {
		return nil, err
	}
	decoder := codec.NewDecoder(raw[codesKeyAndMapHeaderBytes:],
		codec.DecodeOptions{ErrorCode: narsilerr.CodePersistenceLoadFailed})
	var values []any
	for decoder.More() {
		value, err := decoder.ReadValue()
		if err != nil {
			return nil, coldLoadFailed(`The codes of "`+key+`" are not MessagePack`, key)
		}
		values = append(values, value)
	}
	if len(values) < codesValueCount {
		return nil, coldLoadFailed(`The file "`+key+`" holds its codes in another layout`, key)
	}
	listed, centroidIsList := values[3].([]any)
	if values[0] != "bits" || values[2] != "centroid" || !centroidIsList {
		return nil, coldLoadFailed(`The file "`+key+`" holds its codes in another layout`, key)
	}
	bits, isNumber := values[1].(float64)
	if !isNumber || (bits != 1 && bits != 2 && bits != 4 && bits != 8) {
		return nil, coldLoadFailed(`The file "`+key+`" holds codes of another bit width`, key)
	}
	centroid := make([]float32, len(listed))
	for at, value := range listed {
		number, isNumber := value.(float64)
		if !isNumber {
			number = math.NaN()
		}
		centroid[at] = float32(number)
	}
	return &coldCodes{bits: uint32(bits), centroid: centroid}, nil
}

func requireColdCodes(source coldSource, sections map[string]paged.Section, key string) error {
	_, err := coldCodesOf(source, sections, key)
	return err
}

func requireColdFile(ctx context.Context, store checkpoint.Store, file manifest.VectorFileRef) (bool, error) {
	source, err := openColdSource(ctx, store, file.File)
	if err != nil {
		return false, err
	}
	defer source.close()
	head, cold, err := coldHead(source, file.File)
	if err != nil || !cold {
		return false, err
	}
	key := file.File.Key
	list, err := paged.DecodeSectionsAllowing(head["sections"], source.size-envelope.HeaderBytes,
		`head of "`+key+`"`, vectorPageSizes)
	if err != nil {
		return false, err
	}
	sections := make(map[string]paged.Section, len(list))
	for _, section := range list {
		sections[section.Name] = section
	}
	if err := requireColdCodes(source, sections, key); err != nil {
		return false, err
	}
	for _, name := range []string{"magnitudes", "docIds", "idOffsets", "idOrder", "vectors"} {
		if _, listed := sections[name]; !listed {
			return false, coldLoadFailed(`The head of "`+key+`" lists no section "`+name+`"`, key)
		}
		if name != "magnitudes" {
			continue
		}
		if magnitudes := sections[name].Length / float64Bytes; magnitudes != int64(file.Count) {
			return false, coldLoadFailed(`The file "`+key+`" holds `+strconv.FormatInt(magnitudes, 10)+` magnitudes`,
				key)
		}
	}
	for _, section := range list {
		if err := paged.CheckSectionPages(ctx, source.reader, section, key); err != nil {
			return false, err
		}
	}
	return true, nil
}

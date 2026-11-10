package paged

import (
	"cmp"
	"math"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const (
	EnvelopeVersion           = 6
	HeadVersion               = 1
	SegmentPageBytes          = 65_536
	SectionAlignmentBytes     = 4
	PayloadPrefixBytes        = 8
	PostingWidthBytes         = 8
	PositionWidthBytes        = 4
	SmallestBlockPostings     = 128
	DocumentBlockMinRawBytes  = 65_536
	MaxDocumentBlockRawBytes  = 16_842_752
	IDSampleInterval          = 256
	BlockSummaryBytes         = 22
	DocumentBlockBytes        = 20
	pageChecksumBytes         = 4
	blockSummaryMaxTermOffset = 4
	blockSummaryMinLengthAt   = 6
	blockSummaryEntriesAt     = 14
	blockSummaryDocumentsAt   = 18
	documentBlockOffsetAt     = 4
	documentBlockLengthAt     = 12
	documentBlockRawLengthAt  = 16
)

type Section struct {
	Name      string
	Offset    int64
	Length    int64
	PageBytes int64
	Checksums []byte
}

func (section Section) PageCount() int64 {
	return (section.Length + section.PageBytes - 1) / section.PageBytes
}

type Head struct {
	Schema        map[string]string
	Tombstones    []string
	DocumentCount uint32
	FieldNames    []string
	Sections      []Section
}

func loadFailed(message string, details map[string]any) error {
	return narsilerr.New(narsilerr.CodePersistenceLoadFailed, message, details)
}

func isByteCount(value any) (int64, bool) {
	number, ok := value.(float64)
	if !ok || number < 0 || number > form.MaxSafeInteger || number != math.Trunc(number) {
		return 0, false
	}
	return int64(number), true
}

func decodeSection(raw any, what string, allowedPageBytes []int64) (Section, error) {
	entry, ok := raw.(map[string]any)
	if !ok {
		return Section{}, loadFailed("The "+what+" lists a section that is not a map", nil)
	}
	name, ok := entry["name"].(string)
	if !ok || name == "" {
		return Section{}, loadFailed("The "+what+" lists a section without a name", nil)
	}
	offset, offsetOK := isByteCount(entry["offset"])
	length, lengthOK := isByteCount(entry["length"])
	if !offsetOK || !lengthOK {
		return Section{}, loadFailed("The "+what+" gives section \""+name+"\" an invalid place",
			map[string]any{"section": name})
	}
	pageNumber, ok := entry["pageBytes"].(float64)
	pageBytes := int64(pageNumber)
	if !ok || float64(pageBytes) != pageNumber || !slices.Contains(allowedPageBytes, pageBytes) {
		return Section{}, loadFailed("The "+what+" gives section \""+name+"\" a page size it does not allow",
			map[string]any{"section": name, "pageBytes": entry["pageBytes"]})
	}
	checksums, ok := entry["checksums"].([]byte)
	if !ok {
		return Section{}, loadFailed("The "+what+" gives section \""+name+"\" no checksums",
			map[string]any{"section": name})
	}
	section := Section{Name: name, Offset: offset, Length: length, PageBytes: pageBytes, Checksums: checksums}
	if int64(len(checksums)) != section.PageCount()*pageChecksumBytes {
		return Section{}, loadFailed("The "+what+" gives section \""+name+"\" the wrong number of checksum bytes",
			map[string]any{"section": name, "checksumBytes": len(checksums)})
	}
	return section, nil
}

func decodeSections(raw any, payloadLength int64, what string) ([]Section, error) {
	return DecodeSectionsAllowing(raw, payloadLength, what, []int64{SegmentPageBytes})
}

func DecodeSectionsAllowing(raw any, payloadLength int64, what string, allowedPageBytes []int64) ([]Section,
	error) {
	list, ok := raw.([]any)
	if !ok {
		return nil, loadFailed("The "+what+" holds no section list", nil)
	}
	sections := make([]Section, 0, len(list))
	names := make(map[string]struct{}, len(list))
	for _, element := range list {
		section, err := decodeSection(element, what, allowedPageBytes)
		if err != nil {
			return nil, err
		}
		if _, repeated := names[section.Name]; repeated {
			return nil, loadFailed("The "+what+" repeats section \""+section.Name+"\"",
				map[string]any{"section": section.Name})
		}
		names[section.Name] = struct{}{}
		if section.Offset+section.Length > payloadLength {
			return nil, loadFailed("The "+what+" ends section \""+section.Name+"\" outside the payload",
				map[string]any{"section": section.Name})
		}
		sections = append(sections, section)
	}
	byOffset := slices.Clone(sections)
	slices.SortStableFunc(byOffset, func(left Section, right Section) int {
		return cmp.Compare(left.Offset, right.Offset)
	})
	for at := 1; at < len(byOffset); at++ {
		before := byOffset[at-1]
		if before.Offset+before.Length > byOffset[at].Offset {
			return nil, loadFailed("The "+what+" overlaps section \""+before.Name+"\" with \""+byOffset[at].Name+"\"",
				map[string]any{"section": before.Name})
		}
	}
	return sections, nil
}

func stringRecord(value any) (map[string]string, bool) {
	record, ok := value.(map[string]any)
	if !ok {
		return nil, false
	}
	flat := make(map[string]string, len(record))
	for key, element := range record {
		text, isText := element.(string)
		if !isText {
			return nil, false
		}
		flat[key] = text
	}
	return flat, true
}

func stringList(value any) ([]string, bool) {
	list, ok := value.([]any)
	if !ok {
		return nil, false
	}
	texts := make([]string, 0, len(list))
	for _, element := range list {
		text, isText := element.(string)
		if !isText {
			return nil, false
		}
		texts = append(texts, text)
	}
	return texts, true
}

func DecodeHead(encoded []byte, payloadLength int64, what string) (Head, error) {
	decoded, err := codec.Unmarshal(encoded, codec.DecodeOptions{ErrorCode: narsilerr.CodePersistenceLoadFailed})
	if err != nil {
		return Head{}, narsilerr.Wrap(narsilerr.CodePersistenceLoadFailed,
			"The head of "+what+" is not MessagePack: "+err.Error(), err, nil)
	}
	entry, ok := decoded.(map[string]any)
	if !ok {
		return Head{}, loadFailed("The head of "+what+" is not a map", nil)
	}
	if version, isNumber := entry["v"].(float64); !isNumber || version != HeadVersion {
		return Head{}, narsilerr.New(narsilerr.CodeEnvelopeVersionMismatch,
			"The head of "+what+" was written in another layout, and this build reads layout 1 alone",
			map[string]any{"version": entry["v"]})
	}
	head := Head{}
	if head.Schema, ok = stringRecord(entry["schema"]); !ok {
		return Head{}, loadFailed("The head of "+what+" holds no schema", nil)
	}
	if head.Tombstones, ok = stringList(entry["tombstones"]); !ok {
		return Head{}, loadFailed("The head of "+what+" holds no tombstone list", nil)
	}
	if head.FieldNames, ok = stringList(entry["fieldNames"]); !ok {
		return Head{}, loadFailed("The head of "+what+" holds no field names", nil)
	}
	count, ok := isByteCount(entry["documentCount"])
	if !ok || count > math.MaxUint32 {
		return Head{}, loadFailed("The head of "+what+" holds an invalid document count", nil)
	}
	head.DocumentCount = uint32(count)
	head.Sections, err = decodeSections(entry["sections"], payloadLength, "head of "+what)
	if err != nil {
		return Head{}, err
	}
	return head, nil
}

func (head Head) Section(name string) (Section, bool) {
	for _, section := range head.Sections {
		if section.Name == name {
			return section, true
		}
	}
	return Section{}, false
}

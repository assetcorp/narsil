package paged

import (
	"encoding/binary"
	"io"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type SectionSource struct {
	Name      string
	Length    int64
	Checksums []byte
	WriteTo   func(io.Writer) error
}

type HeadFields struct {
	Schema        map[string]string
	Tombstones    []string
	DocumentCount uint32
	FieldNames    []string
}

func saveFailed(message string, details map[string]any) error {
	return narsilerr.New(narsilerr.CodePersistenceSaveFailed, message, details)
}

func PageChecksums(data []byte) []byte {
	pages := (len(data) + SegmentPageBytes - 1) / SegmentPageBytes
	checksums := make([]byte, 0, pages*pageChecksumBytes)
	for page := range pages {
		from := page * SegmentPageBytes
		checksums = binary.LittleEndian.AppendUint32(checksums, codec.CRC32(data[from:min(from+SegmentPageBytes, len(data))]))
	}
	return checksums
}

func BytesSection(name string, data []byte) SectionSource {
	return SectionSource{
		Name:      name,
		Length:    int64(len(data)),
		Checksums: PageChecksums(data),
		WriteTo: func(writer io.Writer) error {
			_, err := writer.Write(data)
			return err
		},
	}
}

func alignedUp(offset int64) int64 {
	return (offset + SectionAlignmentBytes - 1) / SectionAlignmentBytes * SectionAlignmentBytes
}

func placeSections(sources []SectionSource, start int64) []Section {
	cursor := start
	sections := make([]Section, len(sources))
	for at, source := range sources {
		offset := alignedUp(cursor)
		cursor = offset + source.Length
		sections[at] = Section{Name: source.Name, Offset: offset, Length: source.Length, PageBytes: SegmentPageBytes,
			Checksums: source.Checksums}
	}
	return sections
}

func encodeHead(fields HeadFields, sections []Section) ([]byte, error) {
	listed := make([]any, len(sections))
	for at, section := range sections {
		listed[at] = codec.OrderedMap{
			{Key: "name", Value: section.Name},
			{Key: "offset", Value: float64(section.Offset)},
			{Key: "length", Value: float64(section.Length)},
			{Key: "pageBytes", Value: float64(section.PageBytes)},
			{Key: "checksums", Value: section.Checksums},
		}
	}
	return codec.Marshal(codec.OrderedMap{
		{Key: "v", Value: float64(HeadVersion)},
		{Key: "schema", Value: fields.Schema},
		{Key: "tombstones", Value: fields.Tombstones},
		{Key: "documentCount", Value: float64(fields.DocumentCount)},
		{Key: "fieldNames", Value: fields.FieldNames},
		{Key: "sections", Value: listed},
	}, codec.EncodeOptions{ErrorCode: narsilerr.CodePersistenceSaveFailed})
}

type plannedSegment struct {
	head          []byte
	sections      []Section
	payloadLength int64
}

func planSegment(fields HeadFields, sources []SectionSource) (plannedSegment, error) {
	headLength := int64(0)
	for range MaxStableHeadAttempts {
		start := alignedUp(PayloadPrefixBytes + headLength)
		sections := placeSections(sources, start)
		head, err := encodeHead(fields, sections)
		if err != nil {
			return plannedSegment{}, err
		}
		if int64(len(head)) != headLength {
			headLength = int64(len(head))
			continue
		}
		payloadLength := start
		if len(sections) > 0 {
			last := sections[len(sections)-1]
			payloadLength = last.Offset + last.Length
		}
		return plannedSegment{head: head, sections: sections, payloadLength: payloadLength}, nil
	}
	return plannedSegment{}, saveFailed("The head of the "+what+" fails to settle on one length", nil)
}

func requireSources(sources []SectionSource) error {
	names := make(map[string]struct{}, len(sources))
	for _, source := range sources {
		if source.Name == "" || source.Length < 0 || source.WriteTo == nil {
			return saveFailed("A section of the "+what+" has no name, length, or bytes", map[string]any{"section": source.Name})
		}
		if _, repeated := names[source.Name]; repeated {
			return saveFailed("The "+what+" repeats section \""+source.Name+"\"", map[string]any{"section": source.Name})
		}
		names[source.Name] = struct{}{}
		pages := (source.Length + SegmentPageBytes - 1) / SegmentPageBytes
		if int64(len(source.Checksums)) != pages*pageChecksumBytes {
			return saveFailed("Section \""+source.Name+"\" of the "+what+" carries the wrong number of checksums",
				map[string]any{"section": source.Name})
		}
	}
	return nil
}

func payloadChecksum(prefix []byte, plan plannedSegment) uint32 {
	state := codec.CRC32Update(codec.CRC32Update(codec.CRC32Init(), prefix), plan.head)
	checksum := codec.CRC32Final(state)
	cursor := int64(len(prefix) + len(plan.head))
	for _, section := range plan.sections {
		if padding := section.Offset - cursor; padding > 0 {
			checksum = codec.CRC32Combine(checksum, codec.CRC32(make([]byte, padding)), padding)
		}
		for page := range section.PageCount() {
			pageLength := min(section.PageBytes, section.Length-page*section.PageBytes)
			checksum = codec.CRC32Combine(checksum, pageChecksum(section, page), pageLength)
		}
		cursor = section.Offset + section.Length
	}
	return checksum
}

func WriteSegment(writer io.Writer, fields HeadFields, sources []SectionSource) (keyword.Written, error) {
	if err := requireSources(sources); err != nil {
		return keyword.Written{}, err
	}
	plan, err := planSegment(fields, sources)
	if err != nil {
		return keyword.Written{}, err
	}
	prefix := make([]byte, 0, PayloadPrefixBytes)
	prefix = binary.LittleEndian.AppendUint32(prefix, uint32(len(plan.head)))
	prefix = binary.LittleEndian.AppendUint32(prefix, codec.CRC32(plan.head))
	checksum := payloadChecksum(prefix, plan)
	header, err := envelope.ChecksummedHeader(EnvelopeVersion, plan.payloadLength, checksum, what)
	if err != nil {
		return keyword.Written{}, err
	}
	output := &countingWriter{target: writer}
	output.write(envelope.AppendHeader(nil, header))
	output.write(prefix)
	output.write(plan.head)
	cursor := int64(len(prefix) + len(plan.head))
	for at, section := range plan.sections {
		output.write(make([]byte, section.Offset-cursor))
		if output.err != nil {
			break
		}
		checked := &sectionWriter{target: output, section: section}
		if err := sources[at].WriteTo(checked); err != nil && output.err == nil {
			output.err = narsilerr.Wrap(narsilerr.CodePersistenceSaveFailed,
				"Section \""+section.Name+"\" of the "+what+" fails to write", err, nil)
		}
		if output.err == nil {
			output.err = checked.finish()
		}
		cursor = section.Offset + section.Length
	}
	if output.err != nil {
		return keyword.Written{}, output.err
	}
	return keyword.Written{Bytes: int64(envelope.HeaderBytes) + plan.payloadLength, Checksum: checksum}, nil
}

type countingWriter struct {
	target io.Writer
	err    error
}

func (output *countingWriter) write(data []byte) {
	if output.err != nil || len(data) == 0 {
		return
	}
	if _, err := output.target.Write(data); err != nil {
		output.err = narsilerr.Wrap(narsilerr.CodePersistenceSaveFailed, "The "+what+" fails to write", err, nil)
	}
}

type sectionWriter struct {
	target  *countingWriter
	section Section
	written int64
	page    int64
	state   uint32
	filled  int64
}

func (checked *sectionWriter) Write(data []byte) (int, error) {
	if checked.written+int64(len(data)) > checked.section.Length {
		return 0, saveFailed("Section \""+checked.section.Name+"\" of the "+what+" writes past its length", nil)
	}
	for rest := data; len(rest) > 0; {
		if checked.filled == 0 {
			checked.state = codec.CRC32Init()
		}
		take := min(int64(len(rest)), checked.section.PageBytes-checked.filled)
		checked.state = codec.CRC32Update(checked.state, rest[:take])
		checked.filled += take
		rest = rest[take:]
		if checked.filled == checked.section.PageBytes || checked.written+int64(len(data)-len(rest)) == checked.section.Length {
			if err := checked.closePage(); err != nil {
				return 0, err
			}
		}
	}
	checked.written += int64(len(data))
	checked.target.write(data)
	if checked.target.err != nil {
		return 0, checked.target.err
	}
	return len(data), nil
}

func (checked *sectionWriter) closePage() error {
	if codec.CRC32Final(checked.state) != pageChecksum(checked.section, checked.page) {
		return saveFailed("Page "+itoaInt(int(checked.page))+" of section \""+checked.section.Name+"\" of the "+what+
			" differs from its listed checksum", nil)
	}
	checked.page++
	checked.filled = 0
	return nil
}

func (checked *sectionWriter) finish() error {
	if checked.written != checked.section.Length {
		return saveFailed("Section \""+checked.section.Name+"\" of the "+what+" writes fewer bytes than its length", nil)
	}
	return nil
}

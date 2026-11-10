package segments

import (
	"errors"
	"fmt"
	"os"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/paged"
)

const PagedPostingWidthBytes = paged.PostingWidthBytes

type Paged struct {
	Keyword  Keyword
	Removals *core.FrozenPagedRemovals
	Postings core.PageSection
	source   *os.File
	reader   *paged.Reader
	file     *core.PagedFile
}

func valuesOf(column keyword.Uint32s) []uint32 {
	values := make([]uint32, column.Len())
	for at := range values {
		values[at] = column.At(at)
	}
	return values
}

func pageSectionOf(file *core.PagedFile, section paged.Section) core.PageSection {
	return core.PageSection{
		File:      file,
		Offset:    uint64(envelope.HeaderBytes + section.Offset),
		Length:    uint64(section.Length),
		PageBytes: uint32(section.PageBytes),
		Checksums: section.Checksums,
	}
}

func OpenPaged(path string, cache *core.PageCache) (*Paged, error) {
	opened := &Paged{}
	var err error
	if opened.source, err = os.Open(path); err != nil {
		return nil, err
	}
	if err := opened.open(path, cache); err != nil {
		opened.Close()
		return nil, err
	}
	return opened, nil
}

func (p *Paged) open(path string, cache *core.PageCache) error {
	info, err := p.source.Stat()
	if err != nil {
		return err
	}
	if p.reader, err = paged.Open(p.source, info.Size()); err != nil {
		return err
	}
	if p.file, err = core.OpenPagedFile(path); err != nil {
		return err
	}
	sections := map[string]core.PageSection{}
	for _, section := range p.reader.Head.Sections {
		sections[section.Name] = pageSectionOf(p.file, section)
	}
	for _, name := range []string{"postings", "removalOffsets", "removals"} {
		if _, held := sections[name]; !held {
			return fmt.Errorf("%w: the paged segment holds no %s section", ErrInvalidInput, name)
		}
	}
	p.Postings = sections["postings"]
	p.Removals = &core.FrozenPagedRemovals{Cache: cache, Offsets: sections["removalOffsets"],
		Values: sections["removals"]}
	surfaces, err := p.reader.SurfaceForms()
	if err != nil {
		return err
	}
	p.Keyword = residentKeyword(p.reader, surfaces)
	return nil
}

func residentKeyword(reader *paged.Reader, surfaces *keyword.SurfaceFormColumn) Keyword {
	resident := &reader.Resident
	names := slices.Clone(reader.Head.FieldNames)
	terms := core.FrozenStrings{Text: resident.Tokens, Offsets: valuesOf(resident.TokenOffsets),
		Counts: valuesOf(resident.DocumentFrequencies)}
	held := Keyword{
		Segment: core.FrozenSegment{
			Terms:          terms,
			PayloadSlots:   identitySlots(len(terms.Counts)),
			PostingOffsets: valuesOf(resident.PostingOffsets),
			PartialFields:  make([]uint8, len(names)),
			DocumentCount:  reader.Head.DocumentCount,
		},
		FieldNames:   names,
		FieldLengths: make([][]uint32, len(names)),
	}
	for _, column := range resident.FieldLengths {
		if at := slices.Index(names, column.Field); at >= 0 {
			held.FieldLengths[at] = valuesOf(column.Lengths)
		}
	}
	if surfaces != nil && surfaces.Counts.Len() > 0 {
		held.Segment.Surfaces = &core.FrozenStrings{Text: surfaces.Text, Offsets: valuesOf(surfaces.Offsets),
			Counts: valuesOf(surfaces.Counts)}
	}
	if partial := resident.PartialWords; partial != nil {
		held.PartialFieldNames = slices.Clone(partial.Fields)
		for field, name := range names {
			if slices.Contains(partial.Fields, name) {
				held.Segment.PartialFields[field] = 1
			}
		}
		held.Segment.Spellings = &core.FrozenStrings{Text: partial.Text, Offsets: valuesOf(partial.Offsets),
			Counts: valuesOf(partial.Counts)}
		held.Segment.SpellingTokens = valuesOf(partial.Tokens)
		held.SpellingRuns = core.FrozenSpellingRuns{Points: valuesOf(partial.Runs), Offsets: valuesOf(partial.RunOffsets),
			Members: valuesOf(partial.RunEntries)}
	}
	return held
}

func (p *Paged) NewState() *State {
	return NewState(&p.Keyword, p.Removals)
}

func (p *Paged) ReadPostings(w *core.Workspace, term uint32, output []byte) (int, error) {
	offsets := p.Keyword.Segment.PostingOffsets
	if uint64(term)+1 >= uint64(len(offsets)) || offsets[term] > offsets[term+1] {
		return 0, fmt.Errorf("%w: the paged segment holds no term %d", ErrInvalidInput, term)
	}
	count := offsets[term+1] - offsets[term]
	if uint64(len(output)) < uint64(count)*PagedPostingWidthBytes {
		return 0, &core.StatusError{Operation: "readPagedPostings", Status: core.StatusNeedsRoom}
	}
	list := core.PagedPostingList{First: offsets[term], Count: count, Documents: p.Keyword.Segment.DocumentCount,
		Fields: uint32(len(p.Keyword.FieldNames))}
	err := w.ReadPagedPostings(p.Removals.Cache, p.Postings, list, output[:uint64(count)*PagedPostingWidthBytes])
	return int(count), err
}

func (p *Paged) Close() {
	if p.file != nil {
		p.file.Close()
	}
	if p.reader != nil {
		p.reader.Close()
	}
	if p.source != nil {
		_ = p.source.Close()
	}
}

func IsPageFault(err error) bool {
	var fault *core.PageError
	return errors.As(err, &fault)
}

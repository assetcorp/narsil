package segments

import (
	"fmt"
	"sync/atomic"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/paged"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/storage"
)

const PagedPostingWidthBytes = paged.PostingWidthBytes

type Paged struct {
	Frozen
	Removals *core.FrozenPagedRemovals
	Postings core.PageSection
	totals   atomic.Pointer[[]float64]
	path     atomic.Pointer[string]
	source   *paged.NativeFile
	reader   *paged.Reader

	sectionNames   map[uint64]string
	holds          atomic.Int64
	payloadChecked atomic.Bool
}

func valuesOf(column keyword.Uint32s) []uint32 {
	values := make([]uint32, column.Len())
	for at := range values {
		values[at] = column.At(at)
	}
	return values
}

func OpenPaged(w *core.Workspace, path string, removalPages *core.PageCache) (*Paged, error) {
	opened := &Paged{}
	opened.path.Store(&path)
	opened.holds.Store(1)
	file, err := storage.OpenForReading(path)
	if err != nil {
		return nil, err
	}
	if opened.source, err = paged.OpenNativeFile(file, path); err != nil {
		return nil, err
	}
	if err := opened.open(w, removalPages); err != nil {
		opened.Close()
		return nil, err
	}
	return opened, nil
}

func (p *Paged) open(w *core.Workspace, removalPages *core.PageCache) error {
	var err error
	if p.reader, err = paged.Open(p.source, p.source.Size()); err != nil {
		return err
	}
	sections := map[string]core.PageSection{}
	p.sectionNames = map[uint64]string{}
	for _, section := range p.reader.Head.Sections {
		held := p.source.PageSection(section)
		sections[section.Name] = held
		p.sectionNames[held.Offset] = section.Name
	}
	for _, name := range []string{"postings", "removalOffsets", "removals"} {
		if _, held := sections[name]; !held {
			return fmt.Errorf("%w: the paged segment holds no %s section", ErrInvalidInput, name)
		}
	}
	p.Postings = sections["postings"]
	p.Removals = &core.FrozenPagedRemovals{Cache: removalPages, Offsets: sections["removalOffsets"],
		Values: sections["removals"]}
	surfaces, err := p.reader.SurfaceForms()
	if err != nil {
		return err
	}
	p.Keyword = residentKeyword(p.reader, surfaces)
	return p.holdFieldIndexes(w)
}

func residentKeyword(reader *paged.Reader, surfaces *keyword.SurfaceFormColumn) Keyword {
	resident := &reader.Resident
	return heldKeyword(keywordColumns{fieldNames: reader.Head.FieldNames, tokens: resident.Tokens,
		tokenOffsets: resident.TokenOffsets, frequencies: resident.DocumentFrequencies,
		postingOffsets: resident.PostingOffsets, fieldLengths: resident.FieldLengths, surfaces: surfaces,
		partialWords: resident.PartialWords, documentCount: reader.Head.DocumentCount})
}

func (p *Paged) NewState() *State {
	state := NewState(&p.Keyword, p.Removals)
	state.pageFailure = p.pageFailure
	return state
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
	lease, err := pagedReadLeases.acquire()
	if err != nil {
		return 0, err
	}
	defer pagedReadLeases.release(lease)
	err = w.ReadPagedPostings(lease.pages, p.Postings, list, output[:uint64(count)*PagedPostingWidthBytes])
	if err != nil {
		return 0, p.pageFailure(err)
	}
	return int(count), nil
}

func (p *Paged) Hold() bool {
	for {
		held := p.holds.Load()
		if held <= 0 {
			return false
		}
		if p.holds.CompareAndSwap(held, held+1) {
			return true
		}
	}
}

func (p *Paged) Suspend() error {
	return p.source.Suspend()
}

func (p *Paged) Resume(relocate func(path string) string) error {
	path := relocate(p.Path())
	file, err := storage.OpenForReading(path)
	if err != nil {
		return err
	}
	if err := p.source.Resume(file, path); err != nil {
		return err
	}
	p.path.Store(&path)
	return nil
}

func (p *Paged) Close() {
	if p.holds.Add(-1) != 0 {
		return
	}
	if p.reader != nil {
		p.reader.Close()
	}
	if p.source != nil {
		_ = p.source.Close()
	}
}

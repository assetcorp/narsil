package segments

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
)

func (p *Paged) fieldColumnsFile() *keyword.Segment {
	resident := &p.reader.Resident
	return &keyword.Segment{DocumentCount: p.reader.Head.DocumentCount, Numeric: resident.Numeric,
		Sizes: resident.Sizes, Boolean: resident.Boolean, Enum: resident.Enum, Geopoint: resident.Geopoint,
		Pattern: resident.Pattern}
}

func (p *Paged) holdFieldIndexes(w *core.Workspace) error {
	if p.reader.Head.DocumentCount == 0 {
		return nil
	}
	derived, err := derivedFieldIndexes(w, p.fieldColumnsFile())
	if err != nil {
		return err
	}
	p.Fields = derived
	return nil
}

func (p *Paged) FieldSchema() map[string]string {
	return p.reader.Head.Schema
}

func (p *Paged) Path() string {
	if path := p.path.Load(); path != nil {
		return *path
	}
	return ""
}

func (p *Paged) Tombstones() []string {
	return p.reader.Head.Tombstones
}

func (p *Paged) OrdinalOf(id string) (uint32, bool, error) {
	ordinal, err := p.reader.OrdinalOf(id)
	if err != nil || ordinal < 0 {
		return 0, false, err
	}
	return uint32(ordinal), true, nil
}

const idSamplePositionBytes = 4

func (p *Paged) IDSampleBytes() uint64 {
	var bytes uint64
	for _, entry := range p.reader.Resident.IDSample {
		bytes += uint64(len(entry.ID)) + idSamplePositionBytes
	}
	return bytes
}

func (p *Paged) DocumentAt(ordinal uint32) ([]byte, error) {
	return p.reader.EncodedDocument(ordinal)
}

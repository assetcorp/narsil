package partition

import (
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/fields"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/query"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

func (p *Partition) View(read *Read) *query.View {
	return p.sides[read.side].view
}

type Settings struct {
	ID              int
	TextFields      []schema.Field
	ValueFields     []schema.Field
	PartialFields   []string
	Analyzer        *analysis.Analyzer
	CollectSurfaces bool
	TrackPositions  bool
	Limits          fields.Limits
	Kept            *KeptColumns
}

type Partition struct {
	settings    Settings
	schema      map[string]schema.ParsedFieldType
	names       *fieldTable
	sides       [2]*side
	pending     []operation
	pendingSide int
	merging     sync.Mutex
}

func New(settings Settings) (*Partition, error) {
	if settings.Kept == nil {
		settings.Kept = &KeptColumns{}
	}
	p := &Partition{settings: settings, schema: schemaTypes(settings), names: newFieldTable(settings.PartialFields)}
	gen := newGeneration()
	for at := range p.sides {
		created, err := p.newSide(at, gen)
		if err != nil {
			p.Release()
			return nil, err
		}
		created.refreshView(p)
		p.sides[at] = created
	}
	return p, nil
}

func (p *Partition) ID() int {
	return p.settings.ID
}

func (p *Partition) Release() {
	for at, held := range p.sides {
		if held != nil {
			held.release()
			p.sides[at] = nil
		}
	}
}

func (p *Partition) catchUp(write *Write) error {
	current := p.sides[write.side]
	if len(p.pending) == 0 || p.pendingSide != write.side {
		return nil
	}
	err := current.applyAll(write.Workspace, p, p.pending)
	current.refreshView(p)
	if err != nil {
		return err
	}
	for at := range p.pending {
		p.pending[at].retire()
	}
	p.pending = nil
	return nil
}

func (p *Partition) record(write *Write, operations []operation) {
	if len(operations) == 0 {
		return
	}
	p.pending = append(p.pending, operations...)
	p.pendingSide = 1 - write.side
}

func (p *Partition) analyser() (analyser, error) {
	pass, err := p.settings.Analyzer.Prepare()
	if err != nil {
		return analyser{}, err
	}
	options := analysis.IndexingOptions
	options.CollectSurfaces = p.settings.CollectSurfaces
	return analyser{pass: pass, options: options, text: p.settings.TextFields}, nil
}

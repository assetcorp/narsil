package partition

import (
	"strconv"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/frozen"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

type Settings struct {
	ID              int
	Fields          []schema.Field
	PartialFields   []string
	Analyzer        *analysis.Analyzer
	CollectSurfaces bool
	TrackPositions  bool
}

type Partition struct {
	id       int
	pair     *pair
	fields   []schema.Field
	settings Settings
	merging  sync.Mutex
}

type Document struct {
	ID     string
	Fields map[string]any
}

type documentLocation struct {
	document *StoredDocument
	segment  *frozen.Segment
	ordinal  uint32
}

func (s *side) locate(id string) documentLocation {
	if document, _, found := s.documents.get(id); found {
		return documentLocation{document: document}
	}
	for _, sub := range s.frozen {
		if ordinal, found := sub.holdsLive(id); found {
			return documentLocation{document: sub.segment.HeldDocument(ordinal), segment: sub.segment, ordinal: ordinal}
		}
	}
	return documentLocation{}
}

func (l documentLocation) found() bool {
	return l.document != nil || l.segment != nil
}

func (l documentLocation) same(other documentLocation) bool {
	if l.segment != nil || other.segment != nil {
		return l.segment == other.segment && l.ordinal == other.ordinal
	}
	return l.document == other.document
}

func (l documentLocation) read() (documentLocation, error) {
	if l.document != nil || l.segment == nil {
		return l, nil
	}
	document, err := l.segment.DocumentAt(l.ordinal)
	if err != nil {
		return documentLocation{}, err
	}
	l.document = document
	return l, nil
}

func New(settings Settings) *Partition {
	return &Partition{id: settings.ID, pair: newPair(settings.Fields, settings.PartialFields), fields: settings.Fields, settings: settings}
}

func (p *Partition) ID() int {
	return p.id
}

func (p *Partition) analysisFor(positions bool) (Analysis, error) {
	pass, err := p.settings.Analyzer.Prepare()
	if err != nil {
		return Analysis{}, err
	}
	return Analysis{Pass: pass, CollectSurfaces: p.settings.CollectSurfaces, TrackPositions: positions && p.settings.TrackPositions}, nil
}

func alreadyExists(id string, partitionID int) error {
	return narsilerr.New(narsilerr.CodeDocAlreadyExists,
		`Document "`+id+`" already exists in partition `+strconv.Itoa(partitionID), map[string]any{"docId": id, "partitionId": partitionID})
}

func notFound(id string) error {
	return narsilerr.New(narsilerr.CodeDocNotFound, `Document "`+id+`" not found in any partition`, map[string]any{"docId": id})
}

func storedFrom(document Document, lengths map[string]uint32) *StoredDocument {
	return &StoredDocument{ID: document.ID, Fields: document.Fields, FieldLengths: lengths, ContentBytes: DocumentValueBytes(document.Fields, 0)}
}

func (p *Partition) Insert(documents []Document) []error {
	failures := make([]error, len(documents))
	analysed, err := p.analysisFor(true)
	if err != nil {
		for index := range failures {
			failures[index] = err
		}
		return failures
	}
	texts := make([]analysedText, len(documents))
	p.eachDocument(len(documents), func(index int) {
		texts[index], failures[index] = analysed.analyseText(documents[index].Fields, p.fields)
	})
	p.pair.writer.Lock()
	defer p.pair.writer.Unlock()
	active := p.pair.activeState()
	claimed := make(map[string]struct{}, len(documents))
	operations := make([]operation, 0, len(documents))
	for index, document := range documents {
		if failures[index] != nil {
			continue
		}
		exists := active.locate(document.ID).found()
		if _, repeated := claimed[document.ID]; exists || repeated {
			failures[index] = alreadyExists(document.ID, p.id)
			continue
		}
		claimed[document.ID] = struct{}{}
		operations = append(operations, operation{kind: insertDocument, next: storedFrom(document, texts[index].lengths), nextText: texts[index]})
	}
	p.pair.publish(operations)
	return failures
}

func (p *Partition) Clear() {
	p.pair.writer.Lock()
	defer p.pair.writer.Unlock()
	p.pair.publish([]operation{{kind: clearDocuments}})
}

type plannedChange struct {
	index    int
	previous documentLocation
	op       operation
}

func (p *Partition) previousDocuments(ids []string, pending []int) ([]documentLocation, []error) {
	previous := make([]documentLocation, len(pending))
	failures := make([]error, len(pending))
	p.pair.read(func(state *side) {
		for at, index := range pending {
			previous[at], failures[at] = state.locate(ids[index]).read()
		}
	})
	return previous, failures
}

func (a Analysis) removalText(previous *StoredDocument, fields []schema.Field) (analysedText, error) {
	return Analysis{Pass: a.Pass, CollectSurfaces: a.CollectSurfaces}.analyseText(previous.Fields, fields)
}

func (p *Partition) Update(documents []Document) []error {
	ids := make([]string, len(documents))
	for index, document := range documents {
		ids[index] = document.ID
	}
	return p.change(ids, func(index int, previous documentLocation, analysed Analysis) (operation, error) {
		document := documents[index]
		if previous.segment == nil && !textFieldsChanged(previous.document.Fields, document.Fields, p.fields) {
			next := storedFrom(document, previous.document.FieldLengths)
			return operation{kind: replaceDocumentValues, previous: previous.document, next: next}, nil
		}
		previousText, err := p.carriedText(previous.segment, previous.document, analysed, previous.segment != nil)
		if err != nil {
			return operation{}, err
		}
		nextText, err := analysed.analyseText(document.Fields, p.fields)
		if err != nil {
			return operation{}, err
		}
		op := operation{kind: replaceDocumentText, previous: previous.document, previousText: previousText,
			next: storedFrom(document, nextText.lengths), nextText: nextText}
		if previous.segment != nil {
			op.kind, op.segment, op.ordinal = moveFrozenDocument, previous.segment, previous.ordinal
		}
		return op, nil
	})
}

func (p *Partition) Remove(ids []string) []error {
	return p.change(ids, func(_ int, previous documentLocation, analysed Analysis) (operation, error) {
		previousText, err := p.carriedText(previous.segment, previous.document, analysed, previous.segment != nil)
		if err != nil {
			return operation{}, err
		}
		op := operation{kind: removeDocument, previous: previous.document, previousText: previousText}
		if previous.segment != nil {
			op.kind, op.segment, op.ordinal = tombstoneFrozenDocument, previous.segment, previous.ordinal
		}
		return op, nil
	})
}

func (p *Partition) change(ids []string, plan func(index int, previous documentLocation, analysed Analysis) (operation, error)) []error {
	failures := make([]error, len(ids))
	analysed, err := p.analysisFor(true)
	if err != nil {
		for index := range failures {
			failures[index] = err
		}
		return failures
	}
	pending := make([]int, len(ids))
	for index := range pending {
		pending[index] = index
	}
	for len(pending) > 0 {
		previous, readFailures := p.previousDocuments(ids, pending)
		planned := make([]plannedChange, 0, len(pending))
		for at, index := range pending {
			if readFailures[at] != nil {
				failures[index] = readFailures[at]
				continue
			}
			change := plannedChange{index: index, previous: previous[at]}
			if change.previous.document != nil {
				change.op, failures[index] = plan(index, change.previous, analysed)
			}
			planned = append(planned, change)
		}
		pending = p.commitChanges(ids, planned, failures)
	}
	return failures
}

func (p *Partition) commitChanges(ids []string, planned []plannedChange, failures []error) []int {
	p.pair.writer.Lock()
	defer p.pair.writer.Unlock()
	active := p.pair.activeState()
	var retry []int
	claimed := map[string]struct{}{}
	operations := make([]operation, 0, len(planned))
	for _, change := range planned {
		id := ids[change.index]
		current := active.locate(id)
		if !current.same(change.previous) {
			failures[change.index] = nil
			retry = append(retry, change.index)
			continue
		}
		if failures[change.index] != nil {
			continue
		}
		if _, repeated := claimed[id]; repeated {
			retry = append(retry, change.index)
			continue
		}
		if !current.found() {
			failures[change.index] = notFound(id)
			continue
		}
		claimed[id] = struct{}{}
		operations = append(operations, change.op)
	}
	p.pair.publish(operations)
	return retry
}

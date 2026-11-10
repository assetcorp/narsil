package partition

import (
	"errors"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/growing"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

type Prepared struct {
	ID      string
	Values  *codec.Document
	Encoded []byte
	text    preparedText
}

func (p *Partition) Prepare(id string, values *codec.Document, encoded []byte) (Prepared, error) {
	analysed, err := p.analyser()
	if err != nil {
		return Prepared{}, err
	}
	text, err := analysed.prepare(values)
	if err != nil {
		return Prepared{}, err
	}
	return Prepared{ID: id, Values: values, Encoded: encoded, text: text}, nil
}

type planner struct {
	partition  *Partition
	write      *Write
	side       *side
	begun      bool
	operations []operation
}

func (p *Partition) planner(write *Write) *planner {
	return &planner{partition: p, write: write, side: p.sides[write.side]}
}

func (pl *planner) commit(err *error) {
	if !pl.begun {
		return
	}
	finished := pl.side.finish(pl.write.Workspace)
	pl.side.refreshView(pl.partition)
	pl.partition.record(pl.write, pl.operations)
	if *err == nil {
		*err = finished
	}
}

func (pl *planner) begin() error {
	if pl.begun {
		return nil
	}
	if err := pl.side.growing.BeginBatch(); err != nil {
		return err
	}
	pl.begun = true
	if missing := pl.partition.missingColumns(pl.side); len(missing) > 0 {
		_ = pl.applyLogged(operation{kind: keepColumns, columns: missing})
	}
	return nil
}

func (pl *planner) run(op operation) error {
	if err := pl.begin(); err != nil {
		return err
	}
	return pl.applyLogged(op)
}

func (pl *planner) applyLogged(op operation) error {
	err := pl.side.apply(pl.write.Workspace, pl.partition, &op)
	op.failed = err != nil
	pl.operations = append(pl.operations, op)
	return err
}

func (pl *planner) growingBytes() uint64 {
	return pl.side.growing.Bytes() + pl.side.fields.RegionBytes()
}

func (pl *planner) freeze() error {
	if pl.side.liveCount == 0 {
		return nil
	}
	if err := pl.begin(); err != nil {
		return err
	}
	result, err := pl.side.freezeGrowing(pl.write.Workspace, pl.partition.settings.ValueFields,
		pl.partition.settings.Kept.List())
	if err != nil {
		return err
	}
	return pl.run(operation{kind: freezeGrowing, freeze: result})
}

func (p *Partition) FreezeGrowing(write *Write, minimumDocuments int) (froze bool, err error) {
	pl := p.planner(write)
	defer pl.commit(&err)
	if pl.side.liveCount < max(1, minimumDocuments) {
		return false, nil
	}
	return true, pl.freeze()
}

func (pl *planner) freezeWhenFull() error {
	if pl.growingBytes() < FreezeAtGrowingBytes {
		return nil
	}
	return pl.freeze()
}

func (pl *planner) numbered(text preparedText) ([]core.FieldTokens, int) {
	names := pl.side.names
	return text.numbered(names.number), len(names.names)
}

func (pl *planner) insertOnce(document *Prepared) error {
	tokens, fieldCount := pl.numbered(document.text)
	ordinal := pl.side.gen.documents.reserve(document.ID)
	return pl.run(operation{kind: insertDocument, id: document.ID, ordinal: ordinal, fieldCount: fieldCount,
		tokens: tokens, document: document.Values, encoded: document.Encoded})
}

func (pl *planner) insert(document *Prepared) error {
	err := pl.insertOnce(document)
	if !errors.Is(err, growing.ErrSegmentFull) || pl.side.liveCount == 0 {
		return err
	}
	if err := pl.freeze(); err != nil {
		return err
	}
	return pl.insertOnce(document)
}

func (p *Partition) Insert(write *Write, documents []Prepared) (failures []error, err error) {
	pl := p.planner(write)
	defer pl.commit(&err)
	failures = make([]error, len(documents))
	if err := pl.freezeWhenFull(); err != nil {
		return failures, err
	}
	claimed := make(map[string]struct{}, len(documents))
	for at := range documents {
		id := documents[at].ID
		if _, repeated := claimed[id]; repeated || pl.side.locate(id).found {
			failures[at] = alreadyExists(id, p.settings.ID)
			continue
		}
		claimed[id] = struct{}{}
		failures[at] = pl.insert(&documents[at])
	}
	return failures, nil
}

func (p *Partition) Clear(write *Write) (err error) {
	pl := p.planner(write)
	defer pl.commit(&err)
	dropped := make([]*frozenSegment, len(pl.side.frozen))
	for at, held := range pl.side.frozen {
		dropped[at] = held.segment
	}
	return pl.run(operation{kind: clearDocuments, dropped: dropped,
		freeze: &freezeResult{next: newGeneration(), columns: p.settings.Kept.List()}})
}

func (pl *planner) previous(id string) (location, *codec.Document, preparedText, error) {
	at := pl.side.locate(id)
	if !at.found {
		return location{}, nil, preparedText{}, notFound(id)
	}
	stored, held, err := pl.side.document(at)
	if err != nil {
		return location{}, nil, preparedText{}, err
	}
	if !held {
		return location{}, nil, preparedText{}, corruptedPartition("a live document holds no stored value", at.ordinal)
	}
	values, err := decodeStored(stored)
	if err != nil {
		return location{}, nil, preparedText{}, err
	}
	analysed, err := pl.partition.analyser()
	if err != nil {
		return location{}, nil, preparedText{}, err
	}
	text, err := analysed.prepare(values)
	return at, values, text, err
}

func (pl *planner) removeAt(id string, at location, values *codec.Document, text preparedText) error {
	if at.frozen >= 0 {
		return pl.run(operation{kind: removeFrozenDocument, id: id, frozen: at.frozen, ordinal: at.ordinal,
			frozenText: text.frozenTokens()})
	}
	removed, _ := pl.numbered(text)
	return pl.run(operation{kind: removeDocument, id: id, ordinal: at.ordinal, removed: removed, before: values})
}

func (p *Partition) Remove(write *Write, ids []string) (failures []error, err error) {
	pl := p.planner(write)
	defer pl.commit(&err)
	failures = make([]error, len(ids))
	for index, id := range ids {
		at, values, text, err := pl.previous(id)
		if err != nil {
			failures[index] = err
			continue
		}
		failures[index] = pl.removeAt(id, at, values, text)
	}
	return failures, nil
}

func textFieldsChanged(before, after *codec.Document, text []schema.Field) bool {
	for _, field := range text {
		previous, wasPresent := presentValue(before, field.Path)
		next, isPresent := presentValue(after, field.Path)
		if wasPresent != isPresent || wasPresent && !sameValue(previous, next) {
			return true
		}
	}
	return false
}

func (pl *planner) update(document *Prepared) error {
	at, values, text, err := pl.previous(document.ID)
	if err != nil {
		return err
	}
	if at.frozen < 0 && !textFieldsChanged(values, document.Values, pl.partition.settings.TextFields) {
		return pl.run(operation{kind: updateValues, id: document.ID, ordinal: at.ordinal, before: values,
			document: document.Values, encoded: document.Encoded})
	}
	if at.frozen >= 0 {
		if err := pl.removeAt(document.ID, at, values, text); err != nil {
			return err
		}
		return pl.insert(document)
	}
	removed, _ := pl.numbered(text)
	tokens, fieldCount := pl.numbered(document.text)
	ordinal := pl.side.gen.documents.reserve(document.ID)
	err = pl.run(operation{kind: replaceDocument, id: document.ID, ordinal: ordinal, previous: at.ordinal,
		fieldCount: fieldCount, tokens: tokens, removed: removed, before: values, document: document.Values,
		encoded: document.Encoded})
	if !errors.Is(err, growing.ErrSegmentFull) {
		return err
	}
	if err := pl.freeze(); err != nil {
		return err
	}
	return pl.update(document)
}

func (p *Partition) Update(write *Write, documents []Prepared) (failures []error, err error) {
	pl := p.planner(write)
	defer pl.commit(&err)
	failures = make([]error, len(documents))
	if err := pl.freezeWhenFull(); err != nil {
		return failures, err
	}
	for at := range documents {
		failures[at] = pl.update(&documents[at])
	}
	return failures, nil
}

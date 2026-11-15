package engine

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/memory"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

type memoryGuard struct {
	monitor    *memory.Monitor
	projection *memory.Projection
}

func newMemoryGuard(config model.MemoryConfig) *memoryGuard {
	monitor := memory.NewMonitor(memory.Fractions{Block: config.BlockWritesAbove.Or(defaultBlockWritesAbove),
		Resume: config.ResumeWritesBelow.Or(defaultResumeWritesBelow)})
	return &memoryGuard{monitor: monitor, projection: memory.NewProjection(monitor)}
}

func (g *memoryGuard) refuseWhileFull(indexName string) error {
	if report := g.monitor.CheckFull(); report.Full {
		return memory.MemoryFull(indexName, report.Figures)
	}
	return nil
}

func (g *memoryGuard) memoryReleased() {
	g.monitor.MemoryReleased()
}

func burstBytesOf(growth partition.WriteGrowth) float64 {
	return memory.BurstBytes(growth.FreezingBytes, growth.CopiedBytes, growth.TableBytes)
}

func (g *memoryGuard) takeGroup(indexName string, ix *index.Index, bounds *documentBounds, start,
	mostDocuments int) (*memory.Reservation, error) {
	burst := func(count int) memory.Burst {
		if ix == nil {
			return memory.Burst{}
		}
		return memory.Burst{Key: ix, Bytes: ix.WriteBurst(bounds.docIDs[start:start+count], burstBytesOf)}
	}
	return g.projection.TakeGroup(indexName, bounds.bounds, start, mostDocuments, burst, bounds.countExactly)
}

func (g *memoryGuard) reserveDocument(entry *indexEntry, docID string, document *model.Document) (*memory.Reservation,
	error) {
	bounds := boundsOf(entry, []*model.Document{document}, func(int) string { return docID })
	if bounds.bounds[0] == 0 {
		return &memory.Reservation{}, nil
	}
	return g.takeGroup(entry.name, entry.index(), bounds, 0, 1)
}

type entryBoundShape struct {
	analyzer *analysis.Analyzer
	shape    *memory.Shape
}

func termsOf(analyzer *analysis.Analyzer) memory.TermVisitor {
	return func(text string, visit func(term string)) error {
		return analyzer.PrepareWithoutStopWords().Visit(text, analysis.Options{}, func(token analysis.Token) {
			visit(token.Term)
		})
	}
}

func (entry *indexEntry) memoryShape() *memory.Shape {
	analyzer := entry.currentAnalyzer()
	if held := entry.boundShape.Load(); held != nil && held.analyzer == analyzer {
		return held.shape
	}
	embedded := map[string]struct{}{}
	if embedding := entry.config.Embedding; embedding != nil {
		for target := range embedding.Fields {
			embedded[target] = struct{}{}
		}
	}
	var custom memory.TermVisitor
	if analyzer.HasCustomTokenizer() {
		custom = termsOf(analyzer)
	}
	shape := memory.NewShape(entry.parsed.Fields(), core.LanguageNgramSize(analyzer.Language()), embedded, custom,
		termsOf(analyzer))
	entry.boundShape.Store(&entryBoundShape{analyzer: analyzer, shape: shape})
	return shape
}

type documentBounds struct {
	shape     *memory.Shape
	documents []*model.Document
	docIDs    []string
	bounds    []float64
}

func boundsOf(entry *indexEntry, documents []*model.Document, idOf func(at int) string) *documentBounds {
	shape := entry.memoryShape()
	held := &documentBounds{shape: shape, documents: documents, docIDs: make([]string, len(documents)),
		bounds: make([]float64, len(documents))}
	for at, document := range documents {
		held.docIDs[at] = idOf(at)
		if document != nil {
			held.bounds[at] = shape.Bound(document)
		}
	}
	return held
}

func (b *documentBounds) countExactly(position int) {
	document := b.documents[position]
	if document == nil {
		return
	}
	if counted, found := b.shape.CountedBound(document); found {
		b.bounds[position] = min(b.bounds[position], counted)
	}
}

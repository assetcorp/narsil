package engine

import (
	"context"
	"io"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/export"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/indexconfig"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist"
)

func (n *Narsil) openArchive(ctx context.Context, entry *indexEntry) (*persist.Archive, error) {
	if entry.durable != nil {
		return entry.durable.OpenArchive(ctx)
	}
	entry.writeMu.Lock()
	defer entry.writeMu.Unlock()
	return persist.ArchiveFromMemory(ctx, entry.handle)
}

// Snapshot writes a snapshot archive of the index called indexName to
// destination: its settings, a checkpoint of every document and vector, and,
// when options.QueryHistory is set, the query history that the index holds.
// Restore reads the archive back in this engine or in the TypeScript one.
// It returns CodeConfigInvalid for an index that uses a tokenizer instance or
// a stop word function, because an archive keeps no code.
func (n *Narsil) Snapshot(ctx context.Context, indexName string, options SnapshotOptions, destination io.Writer) error {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return err
	}
	defer release()
	configuration, err := entry.configuration()
	if err != nil {
		return err
	}
	config, err := indexconfig.Write(configuration, false)
	if err != nil {
		return err
	}
	opened, err := n.openArchive(ctx, entry)
	if err != nil {
		return err
	}
	defer opened.Release()
	var history persist.HistoryEntries
	if options.QueryHistory {
		history = n.historyEntries(entry.name)
	}
	return opened.Write(ctx, destination, config, history)
}

// ExportDocuments writes every document of the index called indexName to
// destination as a document export: one JSON line with the index settings,
// then one JSON line per document with its vectors. ImportDocumentExport
// reads it back into an index of this engine or of the TypeScript one.
func (n *Narsil) ExportDocuments(ctx context.Context, indexName string, destination io.Writer) error {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return err
	}
	defer release()
	configuration, err := entry.configuration()
	if err != nil {
		return err
	}
	opened, err := n.openArchive(ctx, entry)
	if err != nil {
		return err
	}
	defer opened.Release()
	return opened.Export(ctx, destination, configuration.Value())
}

func (n *Narsil) prepareImportTarget(ctx context.Context, indexName string, configuration indexconfig.Configuration) error {
	stored := storedFromConfiguration(configuration)
	if !n.known(indexName) {
		err := n.CreateIndex(ctx, indexName, stored.config)
		if narsilerr.CodeOf(err) != narsilerr.CodeIndexAlreadyExists {
			return err
		}
	}
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return err
	}
	defer release()
	existing := flatSchemaOf(entry.parsed)
	exported := configuration.Schema
	for _, field := range sortedNames(unionKeys(existing, exported)) {
		if existing[field] == exported[field] {
			continue
		}
		return narsilerr.New(narsilerr.CodeConfigInvalid,
			`Index "`+indexName+`" gives field "`+field+`" another type than the export does, so the import cannot write into it`,
			map[string]any{"indexName": indexName, "field": field})
	}
	return nil
}

func unionKeys(left, right map[string]string) map[string]struct{} {
	union := make(map[string]struct{}, len(left)+len(right))
	for key := range left {
		union[key] = struct{}{}
	}
	for key := range right {
		union[key] = struct{}{}
	}
	return union
}

// ImportDocumentExport reads a document export from source into the index
// called indexName, creating the index from the export's settings when it
// does not exist. A document whose ID the index already holds replaces the
// stored one. The result counts the imported documents and lists the first
// 1,000 refused lines by line number. It returns CodeConfigInvalid for a
// header that is not a document export or for an index whose schema gives a
// field another type than the export.
func (n *Narsil) ImportDocumentExport(ctx context.Context, indexName string, source io.Reader) (DocumentImportResult, error) {
	leave, err := n.enter()
	if err != nil {
		return model.DocumentImportResult{}, err
	}
	defer leave()
	defer n.emitWrite(indexName)
	if err := validateIndexName(indexName); err != nil {
		return model.DocumentImportResult{}, err
	}
	reader, header, err := export.NewReader(source)
	if err != nil {
		return model.DocumentImportResult{}, err
	}
	configuration, err := indexconfig.Decode(header.Index, exportHeaderHolder, indexconfig.ExportHeaderReject)
	if err != nil {
		return model.DocumentImportResult{}, err
	}
	if err := n.prepareImportTarget(ctx, indexName, configuration); err != nil {
		return model.DocumentImportResult{}, err
	}
	imported, err := persist.Import(ctx, reader, func(ctx context.Context, batch []persist.ImportDocument) ([]error, error) {
		return n.importBatch(ctx, indexName, batch)
	})
	result := model.DocumentImportResult{Imported: imported.Imported, RefusedCount: imported.RefusedCount,
		Refused: make([]model.ImportRefusal, 0, len(imported.Refused))}
	for _, refused := range imported.Refused {
		result.Refused = append(result.Refused, model.ImportRefusal{Line: refused.Line, Code: refused.Code, Message: refused.Message})
	}
	return result, err
}

func (n *Narsil) importBatch(ctx context.Context, indexName string, batch []persist.ImportDocument) ([]error, error) {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return nil, err
	}
	defer release()
	failures := make([]error, len(batch))
	position := make(map[string]int, len(batch))
	inserts := make([]*model.Document, 0, len(batch))
	outcome := newBatchOutcome()
	defer entry.scheduleVectorBuilds(outcome.touched)
	for at, document := range batch {
		position[document.ID] = at
		held, err := entry.index().Has(ctx, document.ID)
		if err != nil {
			return nil, err
		}
		imported := model.DocumentFromMap(document.Document)
		if held {
			update := model.DocumentUpdate{DocID: document.ID, Document: imported}
			if err := n.updateOne(ctx, entry, update, outcome.touched); err != nil {
				if !isPerDocument(err) {
					return nil, err
				}
				failures[at] = err
			}
			continue
		}
		inserts = append(inserts, imported)
	}
	for start := 0; start < len(inserts); start += batchChunkSize {
		end := min(start+batchChunkSize, len(inserts))
		if err := n.insertChunk(ctx, entry, inserts[start:end], outcome); err != nil {
			return nil, err
		}
	}
	for _, failure := range outcome.result.Failed {
		if at, found := position[failure.DocID]; found && failures[at] == nil {
			failures[at] = failure.Err
		}
	}
	n.afterWrite(entry)
	return failures, nil
}

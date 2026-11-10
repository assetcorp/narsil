package persist

import (
	"context"
	"sort"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/export"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type ImportDocument struct {
	Line     int
	ID       string
	Document map[string]any
}

type ImportRefusal struct {
	Line    int
	Code    string
	Message string
}

type ImportResult struct {
	Imported     int
	RefusedCount int
	Refused      []ImportRefusal
}

type ImportApply func(ctx context.Context, batch []ImportDocument) ([]error, error)

type importState struct {
	apply           ImportApply
	batch           []ImportDocument
	batchIDs        map[string]struct{}
	result          ImportResult
	highestReported int
}

func (state *importState) highestReportedAt() int {
	highest := 0
	for at := 1; at < len(state.result.Refused); at++ {
		if state.result.Refused[at].Line > state.result.Refused[highest].Line {
			highest = at
		}
	}
	return highest
}

func (state *importState) refuse(line int, err error) {
	code, message := narsilerr.CodeDocValidationFailed, err.Error()
	if typed, ok := narsilerr.As(err); ok {
		code, message = typed.Code, typed.Message
	}
	state.result.RefusedCount++
	refused := ImportRefusal{Line: line, Code: code, Message: message}
	if len(state.result.Refused) < MaxImportRefusalsReported {
		state.result.Refused = append(state.result.Refused, refused)
		if len(state.result.Refused) == MaxImportRefusalsReported {
			state.highestReported = state.highestReportedAt()
		}
		return
	}
	if line >= state.result.Refused[state.highestReported].Line {
		return
	}
	state.result.Refused[state.highestReported] = refused
	state.highestReported = state.highestReportedAt()
}

func (state *importState) flush(ctx context.Context) error {
	if len(state.batch) == 0 {
		return nil
	}
	batch := state.batch
	state.batch = make([]ImportDocument, 0, ImportBatchDocuments)
	state.batchIDs = make(map[string]struct{}, ImportBatchDocuments)
	failures, err := state.apply(ctx, batch)
	if err != nil {
		return err
	}
	for at, entry := range batch {
		if at < len(failures) && failures[at] != nil {
			state.refuse(entry.Line, failures[at])
			continue
		}
		state.result.Imported++
	}
	return nil
}

func Import(ctx context.Context, reader *export.Reader, apply ImportApply) (ImportResult, error) {
	state := &importState{apply: apply, batchIDs: map[string]struct{}{},
		result: ImportResult{Refused: []ImportRefusal{}}}
	for {
		if err := ctx.Err(); err != nil {
			return state.result, err
		}
		entry, found, err := reader.Next()
		if err != nil {
			return state.result, err
		}
		if !found {
			break
		}
		if entry.Refused != nil {
			state.refuse(entry.Line, entry.Refused)
			continue
		}
		if _, repeated := state.batchIDs[entry.ID]; repeated {
			if err := state.flush(ctx); err != nil {
				return state.result, err
			}
		}
		state.batch = append(state.batch, ImportDocument{Line: entry.Line, ID: entry.ID, Document: entry.Document})
		state.batchIDs[entry.ID] = struct{}{}
		if len(state.batch) >= ImportBatchDocuments {
			if err := state.flush(ctx); err != nil {
				return state.result, err
			}
		}
	}
	if err := state.flush(ctx); err != nil {
		return state.result, err
	}
	sort.SliceStable(state.result.Refused, func(left, right int) bool {
		return state.result.Refused[left].Line < state.result.Refused[right].Line
	})
	return state.result, nil
}

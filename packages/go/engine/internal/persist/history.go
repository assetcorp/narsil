package persist

import (
	"context"
	"io"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/archive"
)

type HistoryEntries func(ctx context.Context, emit func(file []byte) error) error

type HistorySink interface {
	Add(ctx context.Context, body io.Reader) error
	Install(ctx context.Context) error
	Abandon(ctx context.Context)
}

func writeHistory(ctx context.Context, writer *archive.Writer, history HistoryEntries) error {
	if history == nil {
		return nil
	}
	return history(ctx, writer.WriteHistory)
}

func (read *archiveRead) addHistory(ctx context.Context, body io.Reader) error {
	if !read.historyOpened {
		read.historyOpened = true
		if read.hooks.History != nil {
			sink, err := read.hooks.History(ctx, read.restoring)
			if err != nil {
				return err
			}
			read.history = sink
		}
	}
	if read.history == nil {
		return nil
	}
	return read.history.Add(ctx, body)
}

func (read *archiveRead) abandonHistory(ctx context.Context) {
	if read.history != nil {
		read.history.Abandon(ctx)
		read.history = nil
	}
}

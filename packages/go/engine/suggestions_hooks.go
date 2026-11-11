package engine

import (
	"context"
	"log/slog"
	"sort"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist"
	"github.com/assetcorp/narsil/packages/go/engine/internal/suggestions"
)

func (n *Narsil) suggestionIndexesOf(sourceName string) []string {
	names := make([]string, 0)
	for name, state := range n.suggestionsStates() {
		if name != sourceName && state.Source != nil && state.Source.Index == sourceName {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}

func (n *Narsil) dropSuggestionIndexesOf(ctx context.Context, sourceName string) error {
	for _, name := range n.suggestionIndexesOf(sourceName) {
		if err := n.DropIndex(ctx, name); err != nil && !isIndexNotFound(err) {
			return err
		}
	}
	return nil
}

func isIndexNotFound(err error) bool {
	held, engineError := narsilerr.As(err)
	return engineError && held.Code == narsilerr.CodeIndexNotFound
}

func (n *Narsil) clearSuggestionLeftovers(ctx context.Context, name string) error {
	if err := n.dropSuggestionIndexesOf(ctx, name); err != nil {
		return err
	}
	if n.suggestions == nil {
		return nil
	}
	return suggestions.RemoveHistoryFolder(ctx, n.suggestions.files, name)
}

func (n *Narsil) beforeSuggestionsCreate(ctx context.Context, entry *indexEntry) error {
	if err := n.clearSuggestionLeftovers(ctx, entry.name); err != nil {
		return err
	}
	n.markSuggestionsIndex(ctx, entry)
	return nil
}

func (n *Narsil) afterSuggestionsDrop(ctx context.Context, name string) {
	if n.suggestions != nil {
		n.suggestions.onDrop(ctx, name)
	}
}

func (n *Narsil) historyEntries(indexName string) persist.HistoryEntries {
	return func(ctx context.Context, emit func(file []byte) error) error {
		runtime := n.suggestions
		if runtime == nil {
			return nil
		}
		if err := runtime.saveDay(ctx, indexName); err != nil {
			return err
		}
		keys, err := suggestions.ListHistoryFolder(ctx, runtime.files, indexName)
		if err != nil {
			return err
		}
		files := make([]suggestions.HistoryFile, 0, len(keys))
		for _, key := range keys {
			if file, isHistory := suggestions.HistoryFileOf(indexName, key); isHistory {
				files = append(files, file)
			}
		}
		sort.Slice(files, func(left, right int) bool {
			if files[left].Day != files[right].Day {
				return files[left].Day < files[right].Day
			}
			return files[left].Key < files[right].Key
		})
		for _, file := range files {
			data, outcome, err := runtime.files.Read(ctx, file.Key)
			if err != nil {
				return err
			}
			if outcome != suggestions.FileRead {
				continue
			}
			if err := emit(data); err != nil {
				return err
			}
		}
		return nil
	}
}

func (n *Narsil) warnSuggestions(indexName string, reason model.QuerySuggestionsWarningReason, message string) {
	n.emitSuggestionsWarning(model.QuerySuggestionsWarningEvent{IndexName: indexName, Reason: reason, Message: message})
}

func (n *Narsil) emitSuggestionsWarning(event model.QuerySuggestionsWarningEvent) {
	if n.events.emit(event) > 0 {
		return
	}
	fields := []any{"indexName", event.IndexName, "reason", string(event.Reason)}
	if event.File != "" {
		fields = append(fields, "file", event.File)
	}
	if event.Message != "" {
		fields = append(fields, "message", event.Message)
	}
	slog.Default().Warn("Popular query suggestions warning", fields...)
}

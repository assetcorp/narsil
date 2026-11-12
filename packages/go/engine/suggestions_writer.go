package engine

import (
	"context"

	is "github.com/assetcorp/narsil/packages/go/engine/internal/format/indexsettings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/suggestions"
)

const (
	suggestionOriginPopular = "popular"
	suggestionOriginManual  = "manual"
)

type storedSuggestion struct {
	phrase string
	count  float64
	origin string
}

type undoStep struct {
	name    string
	remove  []string
	restore []storedSuggestion
}

func suggestionsIndexNameOf(indexName, group string) string {
	return indexName + suggestions.SuggestionsIndexInfix + group
}

func suggestionDocument(phrase string, count float64, origin string) *model.Document {
	return model.NewDocument().Set("id", phrase).Set("query", phrase).Set("count", count).Set("origin", origin)
}

func (n *Narsil) heldIndex(name string) (*indexEntry, func(), error) {
	if entry, found := n.lookup(name); found {
		entry.useMu.RLock()
		if !entry.retired {
			return entry, entry.useMu.RUnlock, nil
		}
		entry.useMu.RUnlock()
	}
	return n.acquire(name)
}

func (n *Narsil) suggestionsInsert(ctx context.Context, name string, documents []*model.Document) (
	model.BatchResult, error) {
	entry, release, err := n.heldIndex(name)
	if err != nil {
		return model.BatchResult{}, err
	}
	defer func() { release() }()
	defer n.emitWrite(name)
	outcome := newBatchOutcome()
	defer func() {
		if entry != nil {
			entry.scheduleVectorBuilds(outcome.touched)
		}
	}()
	if entry, release, err = n.insertChunk(ctx, entry, release, documents, outcome); err != nil {
		return outcome.result, err
	}
	n.afterWrite(entry)
	return outcome.result, nil
}

func (n *Narsil) suggestionsUpdate(ctx context.Context, name string, updates []model.DocumentUpdate) (
	model.BatchResult, error) {
	entry, release, err := n.heldIndex(name)
	if err != nil {
		return model.BatchResult{}, err
	}
	defer func() { release() }()
	defer n.emitWrite(name)
	outcome := newBatchOutcome()
	defer func() {
		if entry != nil {
			entry.scheduleVectorBuilds(outcome.touched)
		}
	}()
	for _, update := range updates {
		entry, release, err = n.updateOne(ctx, entry, release, update, outcome.touched)
		if err != nil {
			if entry == nil || !isPerDocument(err) {
				return outcome.result, err
			}
			outcome.fail(update.DocID, err)
			continue
		}
		outcome.result.Succeeded = append(outcome.result.Succeeded, update.DocID)
	}
	n.afterWrite(entry)
	return outcome.result, nil
}

func (n *Narsil) suggestionsRemove(ctx context.Context, name string, ids []string) (int, error) {
	removed := 0
	for start := 0; start < len(ids); start += suggestions.BuildWriteBatch {
		succeeded, err := n.suggestionsRemoveBatch(ctx, name, ids[start:min(start+suggestions.BuildWriteBatch, len(ids))])
		removed += len(succeeded)
		if err != nil {
			return removed, err
		}
	}
	return removed, nil
}

func (n *Narsil) suggestionsRemoveBatch(ctx context.Context, name string, ids []string) ([]string, error) {
	entry, release, err := n.heldIndex(name)
	if err != nil {
		return nil, err
	}
	defer release()
	defer n.emitWrite(name)
	outcome := newBatchOutcome()
	if err := n.removeChunk(ctx, entry, ids, outcome); err != nil {
		return outcome.result.Succeeded, err
	}
	for _, failure := range outcome.result.Failed {
		if failure.Err != nil && failure.Err.Code != narsilerr.CodeDocNotFound {
			return outcome.result.Succeeded, failure.Err
		}
	}
	return outcome.result.Succeeded, nil
}

func requireWritten(result model.BatchResult) error {
	if len(result.Failed) > 0 && result.Failed[0].Err != nil {
		return result.Failed[0].Err
	}
	return nil
}

func (runtime *suggestionsRuntime) createSuggestionsIndex(ctx context.Context, name string,
	source is.QuerySuggestionsSource, language string) error {
	config := model.IndexConfig{
		Schema:     model.Schema{"query": model.FieldString, "count": model.FieldNumber, "origin": model.FieldEnum},
		Language:   language,
		StopWords:  model.StopWordList(),
		Partitions: model.PartitionConfig{MaxPartitions: model.Some(1)},
	}
	return runtime.n.CreateIndex(withSuggestionsMarker(ctx, source), name, config)
}

func (runtime *suggestionsRuntime) ensureSuggestionsIndex(ctx context.Context, indexName, group string,
	created *[]string) (string, error) {
	name := suggestionsIndexNameOf(indexName, group)
	source, err := runtime.view(indexName)
	if err != nil {
		return "", err
	}
	existing, found := runtime.n.suggestionsViewOf(name)
	if !found {
		if err := runtime.createSuggestionsIndex(ctx, name, is.QuerySuggestionsSource{Index: indexName, Group: group},
			source.language); err != nil {
			return "", err
		}
		*created = append(*created, name)
		return name, nil
	}
	marker := existing.state.Source
	if marker == nil || marker.Index != indexName || marker.Group != group {
		return "", narsilerr.New(narsilerr.CodeConfigInvalid, `Index "`+name+
			`" exists without the marker of a suggestions index for "`+indexName+`", so the build leaves it alone`,
			map[string]any{"indexName": name})
	}
	if existing.language != source.language {
		if err := runtime.alignLanguage(ctx, name, source.language); err != nil {
			return "", err
		}
	}
	return name, nil
}

func (runtime *suggestionsRuntime) readSuggestions(ctx context.Context, name string) ([]storedSuggestion,
	map[string]storedSuggestion, error) {
	ordered := make([]storedSuggestion, 0)
	byPhrase := map[string]storedSuggestion{}
	cursor := model.Optional[string]{}
	for {
		page, err := runtime.n.ListDocuments(ctx, name, model.ListParams{Cursor: cursor,
			Limit: model.Some(suggestions.BuildListPage)})
		if err != nil {
			return nil, nil, err
		}
		for _, listed := range page.Documents {
			stored := storedSuggestion{phrase: listed.ID, origin: suggestionOriginPopular}
			held, _ := listed.Document.Get("count")
			if count, isNumber := held.(float64); isNumber {
				stored.count = count
			}
			held, _ = listed.Document.Get("origin")
			if origin, isText := held.(string); isText {
				stored.origin = origin
			}
			if _, seen := byPhrase[listed.ID]; !seen {
				ordered = append(ordered, stored)
			}
			byPhrase[listed.ID] = stored
		}
		if page.Cursor == "" {
			return ordered, byPhrase, nil
		}
		cursor = model.Some(page.Cursor)
	}
}

func (runtime *suggestionsRuntime) writeGroup(ctx context.Context, name string, due []suggestions.DuePhrase,
	banned map[string]bool, onlyAdd bool, undo *[]undoStep) (int, int, error) {
	ordered, stored, err := runtime.readSuggestions(ctx, name)
	if err != nil {
		return 0, 0, err
	}
	var inserts []*model.Document
	var updates []model.DocumentUpdate
	var previous []storedSuggestion
	dueSet := make(map[string]bool, len(due))
	for _, phrase := range due {
		dueSet[phrase.Phrase] = true
		if banned[phrase.Phrase] {
			continue
		}
		current, held := stored[phrase.Phrase]
		count := float64(phrase.Count)
		if !held {
			inserts = append(inserts, suggestionDocument(phrase.Phrase, count, suggestionOriginPopular))
		} else if current.origin == suggestionOriginPopular && current.count != count {
			updates = append(updates, model.DocumentUpdate{DocID: phrase.Phrase,
				Document: suggestionDocument(phrase.Phrase, count, suggestionOriginPopular)})
			previous = append(previous, current)
		}
	}
	var stale []storedSuggestion
	var bannedIDs []string
	for _, current := range ordered {
		if banned[current.phrase] {
			bannedIDs = append(bannedIDs, current.phrase)
		} else if !onlyAdd && current.origin == suggestionOriginPopular && !dueSet[current.phrase] {
			stale = append(stale, current)
		}
	}
	*undo = append(*undo, undoStep{name: name})
	step := &(*undo)[len(*undo)-1]
	n := runtime.n
	for start := 0; start < len(inserts); start += suggestions.BuildWriteBatch {
		result, err := n.suggestionsInsert(ctx, name, inserts[start:min(start+suggestions.BuildWriteBatch, len(inserts))])
		step.remove = append(step.remove, result.Succeeded...)
		if err == nil {
			err = requireWritten(result)
		}
		if err != nil {
			return 0, 0, err
		}
	}
	for start := 0; start < len(updates); start += suggestions.BuildWriteBatch {
		end := min(start+suggestions.BuildWriteBatch, len(updates))
		result, err := n.suggestionsUpdate(ctx, name, updates[start:end])
		succeeded := map[string]bool{}
		for _, id := range result.Succeeded {
			succeeded[id] = true
		}
		for _, entry := range previous[start:end] {
			if succeeded[entry.phrase] {
				step.restore = append(step.restore, entry)
			}
		}
		if err == nil {
			err = requireWritten(result)
		}
		if err != nil {
			return 0, 0, err
		}
	}
	removed := 0
	for start := 0; start < len(stale); start += suggestions.BuildWriteBatch {
		batch := stale[start:min(start+suggestions.BuildWriteBatch, len(stale))]
		ids := make([]string, len(batch))
		for index, entry := range batch {
			ids[index] = entry.phrase
		}
		succeededIDs, err := n.suggestionsRemoveBatch(ctx, name, ids)
		succeeded := map[string]bool{}
		for _, id := range succeededIDs {
			succeeded[id] = true
		}
		removed += len(succeededIDs)
		for _, entry := range batch {
			if succeeded[entry.phrase] {
				step.restore = append(step.restore, entry)
			}
		}
		if err != nil {
			return 0, 0, err
		}
	}
	bannedRemoved, err := n.suggestionsRemove(ctx, name, bannedIDs)
	if err != nil {
		return 0, 0, err
	}
	return len(inserts) + len(updates), removed + bannedRemoved, nil
}

func (runtime *suggestionsRuntime) undoWrites(ctx context.Context, steps []undoStep, banned map[string]bool) error {
	n := runtime.n
	for index := len(steps) - 1; index >= 0; index-- {
		step := steps[index]
		if _, err := n.suggestionsRemove(ctx, step.name, step.remove); err != nil {
			return err
		}
		restore := make([]storedSuggestion, 0, len(step.restore))
		for _, entry := range step.restore {
			if !banned[entry.phrase] {
				restore = append(restore, entry)
			}
		}
		for start := 0; start < len(restore); start += suggestions.BuildWriteBatch {
			batch := restore[start:min(start+suggestions.BuildWriteBatch, len(restore))]
			ids := make([]string, len(batch))
			documents := make([]*model.Document, len(batch))
			for at, entry := range batch {
				ids[at] = entry.phrase
				documents[at] = suggestionDocument(entry.phrase, entry.count, entry.origin)
			}
			if _, err := n.suggestionsRemove(ctx, step.name, ids); err != nil {
				return err
			}
			result, err := n.suggestionsInsert(ctx, step.name, documents)
			if err == nil {
				err = requireWritten(result)
			}
			if err != nil {
				return err
			}
		}
	}
	return nil
}

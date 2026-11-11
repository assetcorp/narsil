package engine

import (
	"context"
	"slices"
	"sync"
	"time"

	is "github.com/assetcorp/narsil/packages/go/engine/internal/format/indexsettings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/suggestions"
)

type suggestionsState struct {
	mu    sync.RWMutex
	state is.QuerySuggestionsState
}

func (held *suggestionsState) current() is.QuerySuggestionsState {
	held.mu.RLock()
	defer held.mu.RUnlock()
	return held.state
}

func (held *suggestionsState) set(next is.QuerySuggestionsState) {
	held.mu.Lock()
	held.state = next
	held.mu.Unlock()
}

type suggestionsMarkerKey struct{}

func withSuggestionsMarker(ctx context.Context, source is.QuerySuggestionsSource) context.Context {
	return context.WithValue(ctx, suggestionsMarkerKey{}, source)
}

func (n *Narsil) markSuggestionsIndex(ctx context.Context, entry *indexEntry) {
	if source, marked := ctx.Value(suggestionsMarkerKey{}).(is.QuerySuggestionsSource); marked {
		entry.suggestions.set(is.QuerySuggestionsState{Source: &source})
	}
}

func suggestionsInvalid(message string, details map[string]any) error {
	return narsilerr.New(narsilerr.CodeConfigInvalid, message, details)
}

func optionalNumber[T int | int64](entries map[string]any, key string, value model.Optional[T]) {
	if held, set := value.Get(); set {
		entries[key] = float64(held)
	}
}

func storedSettingOf(setting model.QuerySuggestionsSetting) (is.QuerySuggestionsSetting, error) {
	fields := make([]any, 0, len(setting.Fields))
	for _, field := range setting.Fields {
		fields = append(fields, field)
	}
	raw := map[string]any{"enabled": setting.Enabled, "fields": fields}
	numbers := []struct {
		key   string
		value model.Optional[int]
	}{{"minPeople", setting.MinPeople}, {"minResults", setting.MinResults}, {"retentionDays", setting.RetentionDays},
		{"maxPhrasesPerDay", setting.MaxPhrasesPerDay}, {"maxPhrasesPerPerson", setting.MaxPhrasesPerPerson},
		{"maxPeoplePerDay", setting.MaxPeoplePerDay}, {"maxGroups", setting.MaxGroups},
		{"minLetters", setting.MinLetters}, {"maxLength", setting.MaxLength}, {"maxWords", setting.MaxWords},
		{"maxDigits", setting.MaxDigits}, {"maxMergePhrases", setting.MaxMergePhrases},
		{"resultChecksPerSecond", setting.ResultChecksPerSecond}}
	for _, number := range numbers {
		optionalNumber(raw, number.key, number.value)
	}
	optionalNumber(raw, "mergeMemoryBytes", setting.MergeMemoryBytes)
	if interval, set := setting.SaveInterval.Get(); set {
		if interval%time.Millisecond != 0 {
			return is.QuerySuggestionsSetting{}, suggestionsInvalid("saveIntervalMs must be a whole number",
				map[string]any{"key": "saveIntervalMs"})
		}
		raw["saveIntervalMs"] = float64(interval.Milliseconds())
	}
	if schedule, set := setting.Schedule.Get(); set {
		raw["schedule"] = schedule
	}
	if zone, set := setting.TimeZone.Get(); set {
		raw["timeZone"] = zone
	}
	return is.ReadQuerySuggestionsSetting(raw, is.Camel)
}

func narrowed(value model.Optional[int64]) model.Optional[int] {
	if held, set := value.Get(); set {
		return model.Some(int(held))
	}
	return model.Optional[int]{}
}

func publicSettingOf(stored *is.QuerySuggestionsSetting) *model.QuerySuggestionsSetting {
	if stored == nil {
		return nil
	}
	setting := &model.QuerySuggestionsSetting{Enabled: stored.Enabled, Fields: slices.Clone(stored.Fields),
		MinPeople: narrowed(stored.MinPeople), MinResults: narrowed(stored.MinResults),
		RetentionDays: narrowed(stored.RetentionDays), MaxPhrasesPerDay: narrowed(stored.MaxPhrasesPerDay),
		MaxPhrasesPerPerson: narrowed(stored.MaxPhrasesPerPerson), MaxPeoplePerDay: narrowed(stored.MaxPeoplePerDay),
		MaxGroups: narrowed(stored.MaxGroups), MinLetters: narrowed(stored.MinLetters),
		MaxLength: narrowed(stored.MaxLength), MaxWords: narrowed(stored.MaxWords),
		MaxDigits: narrowed(stored.MaxDigits), MaxMergePhrases: narrowed(stored.MaxMergePhrases),
		MergeMemoryBytes: stored.MergeMemoryBytes, ResultChecksPerSecond: narrowed(stored.ResultChecksPerSecond),
		Schedule: stored.Schedule, TimeZone: stored.TimeZone}
	if interval, set := stored.SaveIntervalMS.Get(); set {
		setting.SaveInterval = model.Some(time.Duration(interval) * time.Millisecond)
	}
	return setting
}

type suggestionsView struct {
	state    is.QuerySuggestionsState
	schema   map[string]string
	language string
	hasSync  bool
}

func viewOfEntry(entry *indexEntry) suggestionsView {
	return suggestionsView{state: entry.suggestions.current(), schema: flatSchemaOf(entry.parsed),
		language: entry.analysis.language, hasSync: entry.sync.current() != nil}
}

func (n *Narsil) suggestionsViewOf(indexName string) (suggestionsView, bool) {
	slot, entry := n.slotOf(indexName)
	if entry != nil {
		return viewOfEntry(entry), true
	}
	if slot == nil {
		return suggestionsView{}, false
	}
	summary, closed := slot.closedView()
	if !closed {
		return suggestionsView{}, false
	}
	return suggestionsView{state: summary.suggestions, language: summary.language}, true
}

func (view suggestionsView) enabled() (suggestions.Resolved, bool) {
	if view.state.Setting == nil || !view.state.Setting.Enabled {
		return suggestions.Resolved{}, false
	}
	return suggestions.Resolve(*view.state.Setting), true
}

func (view suggestionsView) banned(phrase string) bool {
	return slices.Contains(view.state.BannedQueries, phrase)
}

func (n *Narsil) markedSuggestionIndexes(indexName string) map[string]string {
	byGroup := map[string]string{}
	for name, state := range n.suggestionsStates() {
		if source := state.Source; source != nil && source.Index == indexName {
			byGroup[source.Group] = name
		}
	}
	return byGroup
}

func (n *Narsil) updateSuggestionsState(ctx context.Context, indexName string,
	change func(current is.QuerySuggestionsState) (is.QuerySuggestionsState, error)) error {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return err
	}
	defer release()
	entry.sync.changeMu.Lock()
	defer entry.sync.changeMu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	previous := entry.suggestions.current()
	next, err := change(previous)
	if err != nil {
		return err
	}
	entry.suggestions.set(next)
	if entry.durable == nil {
		return nil
	}
	if err := entry.durable.PersistMetadata(ctx); err != nil {
		entry.suggestions.set(previous)
		return err
	}
	return nil
}

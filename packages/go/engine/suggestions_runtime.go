package engine

import (
	"context"
	"sync"
	"time"

	is "github.com/assetcorp/narsil/packages/go/engine/internal/format/indexsettings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/suggestions"
	"github.com/assetcorp/narsil/packages/go/engine/internal/suggestions/phrase"
)

type suggestionsRuntime struct {
	n         *Narsil
	files     suggestions.Files
	scrambler *suggestions.Scrambler
	days      *suggestions.DayStore
	locks     *nameLocks
	builds    *buildRunner
	timers    *suggestionTimers
	now       func() time.Time

	startMu sync.Mutex
	started bool
}

func (n *Narsil) startSuggestions(ctx context.Context) error {
	var key []byte
	config := n.config.QuerySuggestions
	if config != nil && config.Key != nil {
		held, err := suggestions.KeyOf(config.Key)
		if err != nil {
			return err
		}
		key = held
	}
	runtime := &suggestionsRuntime{n: n, files: suggestions.MemoryFiles(), locks: newNameLocks(), now: time.Now}
	if n.manager != nil {
		runtime.files = suggestions.StoreFiles(n.manager.Store())
	}
	if key != nil {
		runtime.scrambler = suggestions.NewScrambler(key)
		runtime.days = suggestions.NewDayStore(runtime.files, runtime.scrambler, runtime.warn, runtime.now)
	}
	runtime.builds = newBuildRunner(runtime)
	runtime.timers = newSuggestionTimers(runtime)
	n.suggestions = runtime
	if config == nil && !n.holdsEnabledSuggestions() {
		return nil
	}
	return runtime.ensureStarted(ctx)
}

func (n *Narsil) holdsEnabledSuggestions() bool {
	for _, state := range n.suggestionsStates() {
		if state.Setting != nil && state.Setting.Enabled {
			return true
		}
	}
	return false
}

func (n *Narsil) suggestionsStates() map[string]is.QuerySuggestionsState {
	n.indexesMu.RLock()
	defer n.indexesMu.RUnlock()
	states := make(map[string]is.QuerySuggestionsState, len(n.slots))
	for name, slot := range n.slots {
		if summary, closed := slot.closedView(); closed {
			states[name] = summary.suggestions
		}
	}
	for name, entry := range n.indexes {
		states[name] = entry.suggestions.current()
	}
	return states
}

func (n *Narsil) stopSuggestions(ctx context.Context) {
	if n.suggestions != nil {
		n.suggestions.stop(ctx)
	}
}

func (runtime *suggestionsRuntime) ensureStarted(ctx context.Context) error {
	runtime.startMu.Lock()
	defer runtime.startMu.Unlock()
	if runtime.started {
		return nil
	}
	runtime.started = true
	runtime.warnWithoutKey()
	if runtime.scrambler == nil {
		runtime.timers.sweepNow(ctx)
		return nil
	}
	return runtime.timers.start(ctx)
}

func (runtime *suggestionsRuntime) stopping() bool {
	return runtime.n.stopping.Err() != nil
}

func (runtime *suggestionsRuntime) stop(ctx context.Context) {
	runtime.timers.stop()
	if runtime.days == nil {
		return
	}
	for _, indexName := range runtime.days.Indexes() {
		_ = runtime.days.Save(ctx, indexName)
	}
}

func (runtime *suggestionsRuntime) warn(event model.QuerySuggestionsWarningEvent) {
	runtime.n.emitSuggestionsWarning(event)
}

func (runtime *suggestionsRuntime) warnWithoutKey() {
	if runtime.scrambler != nil {
		return
	}
	for name, state := range runtime.n.suggestionsStates() {
		if state.Setting != nil && state.Setting.Enabled {
			runtime.warn(model.QuerySuggestionsWarningEvent{IndexName: name, Reason: model.WarningNoKey})
		}
	}
}

func instanceShutDown() error {
	return narsilerr.New(narsilerr.CodeInstanceShutDown, "The engine is shutting down", nil)
}

func suggestionsNotEnabled(indexName string) error {
	return narsilerr.New(narsilerr.CodeQuerySuggestionsNotEnabled, `Index "`+indexName+
		`" has popular query suggestions off`, map[string]any{"indexName": indexName})
}

func (runtime *suggestionsRuntime) view(indexName string) (suggestionsView, error) {
	entry, release, err := runtime.n.acquire(indexName)
	if err != nil {
		return suggestionsView{}, err
	}
	defer release()
	return viewOfEntry(entry), nil
}

func (runtime *suggestionsRuntime) enabledSetting(indexName string) (suggestions.Resolved, error) {
	view, err := runtime.view(indexName)
	if err != nil {
		return suggestions.Resolved{}, err
	}
	setting, enabled := view.enabled()
	if !enabled {
		return suggestions.Resolved{}, suggestionsNotEnabled(indexName)
	}
	return setting, nil
}

func (runtime *suggestionsRuntime) settingOf(indexName string) *is.QuerySuggestionsSetting {
	view, found := runtime.n.suggestionsViewOf(indexName)
	if !found {
		return nil
	}
	return view.state.Setting
}

func (runtime *suggestionsRuntime) withWriteLock(indexName string, work func() error) error {
	unlock := runtime.locks.lock(indexName)
	defer unlock()
	return work()
}

func (runtime *suggestionsRuntime) saveDay(ctx context.Context, indexName string) error {
	if runtime.days == nil {
		return nil
	}
	return runtime.days.Save(ctx, indexName)
}

func (runtime *suggestionsRuntime) groupAllowed(indexName, group string, maxGroups int, known map[string]bool) bool {
	for marked := range runtime.n.markedSuggestionIndexes(indexName) {
		known[marked] = true
	}
	return known[group] || len(known) < maxGroups
}

func (runtime *suggestionsRuntime) record(ctx context.Context, indexName string, input model.RecordedQuery) (
	model.RecordQueryResult, error) {
	if runtime.stopping() {
		return model.RecordQueryResult{}, instanceShutDown()
	}
	setting, err := runtime.enabledSetting(indexName)
	if err != nil {
		return model.RecordQueryResult{}, err
	}
	if runtime.days == nil {
		return model.RecordQueryResult{Outcome: model.RecordQueryNoKey}, nil
	}
	invalid := model.RecordQueryResult{Outcome: model.RecordQueryInvalid}
	if !phrase.IsPerson(input.Person) || !is.IsGroup(input.Group) {
		return invalid, nil
	}
	accepted, ok := phrase.Accepted(input.Query, setting.PhraseLimits())
	if !ok {
		return invalid, nil
	}
	isBanned := func() bool {
		view, found := runtime.n.suggestionsViewOf(indexName)
		return found && view.banned(accepted)
	}
	if isBanned() {
		return model.RecordQueryResult{Outcome: model.RecordQueryBanned}, nil
	}
	result, err := runtime.days.Count(ctx, indexName, setting, runtime.now(), suggestions.CountRequest{
		Group: input.Group, Phrase: accepted, Person: input.Person,
		GroupAllowed: func(known map[string]bool) bool {
			return runtime.groupAllowed(indexName, input.Group, setting.MaxGroups, known)
		},
		StillEnabled: func() bool {
			current := runtime.settingOf(indexName)
			return current != nil && current.Enabled
		},
		IsBanned: isBanned,
	})
	if err != nil {
		return model.RecordQueryResult{}, err
	}
	if result == suggestions.CountStopped {
		return model.RecordQueryResult{}, suggestionsNotEnabled(indexName)
	}
	recorded := result == suggestions.CountResult(suggestions.CountRecorded)
	if recorded {
		runtime.timers.saveSoon(indexName, time.Duration(setting.SaveIntervalMS)*time.Millisecond)
	}
	return model.RecordQueryResult{Recorded: recorded, Outcome: model.RecordQueryOutcome(result)}, nil
}

func (runtime *suggestionsRuntime) discardHistory(ctx context.Context, indexName string) error {
	runtime.timers.forgetSave(indexName)
	if runtime.days != nil {
		if err := runtime.days.Discard(ctx, indexName); err != nil {
			return err
		}
	}
	return suggestions.RemoveHistoryFolder(ctx, runtime.files, indexName)
}

func (runtime *suggestionsRuntime) onDrop(ctx context.Context, indexName string) {
	runtime.timers.forgetIndex(indexName)
	runtime.builds.forget(indexName)
	if runtime.days != nil {
		_ = runtime.days.Discard(ctx, indexName)
	}
	_ = suggestions.RemoveHistoryFolder(ctx, runtime.files, indexName)
}

func (runtime *suggestionsRuntime) background(work func(ctx context.Context)) bool {
	leave, err := runtime.n.enter()
	if err != nil {
		return false
	}
	go func() {
		defer leave()
		work(runtime.n.stopping)
	}()
	return true
}

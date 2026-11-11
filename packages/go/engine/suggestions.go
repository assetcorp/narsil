package engine

import (
	"context"
	"slices"
	"strconv"

	is "github.com/assetcorp/narsil/packages/go/engine/internal/format/indexsettings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/suggestions"
	"github.com/assetcorp/narsil/packages/go/engine/internal/suggestions/phrase"
)

const groupFormat = `1 to 32 letters, digits, "_", and "-"`

// QuerySuggestions gives the popular query suggestions of one engine: it
// counts the searches that people follow with a click, builds a suggestions
// index per group from the phrases that enough people searched, and manages
// the ban list. Get it from Narsil.QuerySuggestions. Every method is safe to
// call from many goroutines at once.
type QuerySuggestions struct {
	n *Narsil
}

// QuerySuggestions returns the popular query suggestions of the engine. Give
// the engine a key of at least 32 bytes through Config.QuerySuggestions before
// you turn the feature on for an index.
func (n *Narsil) QuerySuggestions() *QuerySuggestions {
	return &QuerySuggestions{n: n}
}

func (handle *QuerySuggestions) runtime(ctx context.Context) (*suggestionsRuntime, func(), error) {
	leave, err := handle.n.enter()
	if err != nil {
		return nil, nil, err
	}
	runtime := handle.n.suggestions
	if runtime == nil {
		leave()
		return nil, nil, instanceShutDown()
	}
	if err := runtime.ensureStarted(ctx); err != nil {
		leave()
		return nil, nil, err
	}
	return runtime, leave, nil
}

// RecordQuery counts one search that a person followed with a click and
// returns whether the engine counted it, with the reason. The engine counts a
// phrase once per person each day and keeps only a keyed scramble of the
// person. It returns CodeIndexNotFound for an unknown index and
// CodeQuerySuggestionsNotEnabled when the index has the feature off.
func (handle *QuerySuggestions) RecordQuery(ctx context.Context, indexName string, query RecordedQuery) (
	RecordQueryResult, error) {
	runtime, leave, err := handle.runtime(ctx)
	if err != nil {
		return RecordQueryResult{}, err
	}
	defer leave()
	return runtime.record(ctx, indexName, query)
}

// UpdateSetting replaces the query suggestions setting of the index called
// indexName and saves it with the index metadata. It returns CodeConfigInvalid
// for a value out of range, a field that is not a string or string[] field of
// the schema, a suggestions index, a source name longer than 210 characters,
// an engine without a key, or an index with device sync on. Turning the
// feature off deletes the counted searches of the index.
func (handle *QuerySuggestions) UpdateSetting(ctx context.Context, indexName string,
	setting QuerySuggestionsSetting) error {
	runtime, leave, err := handle.runtime(ctx)
	if err != nil {
		return err
	}
	defer leave()
	return runtime.updateSetting(ctx, indexName, setting)
}

// Status returns the setting, the last build, the next scheduled build, and
// the suggestions indexes of the index called indexName.
func (handle *QuerySuggestions) Status(ctx context.Context, indexName string) (QuerySuggestionsStatus, error) {
	runtime, leave, err := handle.runtime(ctx)
	if err != nil {
		return QuerySuggestionsStatus{}, err
	}
	defer leave()
	view, err := runtime.view(indexName)
	if err != nil {
		return QuerySuggestionsStatus{}, err
	}
	status := QuerySuggestionsStatus{IndexName: indexName, Setting: publicSettingOf(view.state.Setting),
		LastBuild: runtime.builds.lastBuild(ctx, indexName), SuggestionIndexes: []string{}}
	if at, scheduled := runtime.timers.nextBuildAt(indexName); scheduled {
		status.NextBuildAt = model.Some(at)
	}
	marked := runtime.n.markedSuggestionIndexes(indexName)
	for _, name := range marked {
		status.SuggestionIndexes = append(status.SuggestionIndexes, name)
	}
	slices.Sort(status.SuggestionIndexes)
	return status, nil
}

// Build merges the counted searches of the index called indexName, checks
// that each popular phrase matches enough documents, and writes the phrases
// into the suggestions index of each group. It returns the finished build; a
// build that finds the same counts as the last one reports BuildSkipped, and
// a failed build undoes its writes and reports its error code.
func (handle *QuerySuggestions) Build(ctx context.Context, indexName string) (QuerySuggestionsBuild, error) {
	runtime, leave, err := handle.runtime(ctx)
	if err != nil {
		return QuerySuggestionsBuild{}, err
	}
	defer leave()
	return runtime.builds.start(ctx, indexName, model.BuildTriggerCaller)
}

// Preview returns what the next build would publish, most counted first, up
// to limit phrases. An unset limit lists up to 100 phrases, and a set one must
// be from 1 to 1,000, or Preview returns CodeConfigInvalid.
func (handle *QuerySuggestions) Preview(ctx context.Context, indexName string, requested Optional[int]) (
	QuerySuggestionsPreview, error) {
	limit := requested.Or(suggestions.DefaultPreviewLimit)
	if limit < 1 || limit > suggestions.MaxPreviewLimit {
		return QuerySuggestionsPreview{}, suggestionsInvalid("The preview limit must be a whole number from 1 to "+
			strconv.Itoa(suggestions.MaxPreviewLimit), nil)
	}
	runtime, leave, err := handle.runtime(ctx)
	if err != nil {
		return QuerySuggestionsPreview{}, err
	}
	defer leave()
	if _, err := runtime.enabledSetting(indexName); err != nil {
		return QuerySuggestionsPreview{}, err
	}
	if runtime.scrambler == nil {
		return QuerySuggestionsPreview{}, suggestionsInvalid(
			"This engine has no query suggestions key, so it holds no counts", nil)
	}
	return runtime.previewBuild(ctx, indexName, limit)
}

// Bans returns the ban list of the index called indexName in normal form.
func (handle *QuerySuggestions) Bans(ctx context.Context, indexName string) ([]string, error) {
	runtime, leave, err := handle.runtime(ctx)
	if err != nil {
		return nil, err
	}
	defer leave()
	view, err := runtime.view(indexName)
	if err != nil {
		return nil, err
	}
	return append([]string{}, view.state.BannedQueries...), nil
}

// UpdateBans replaces the ban list of the index called indexName with phrases,
// each normalised as RecordQuery normalises a search, and removes newly banned
// phrases from its suggestions indexes. It returns the stored list, or
// CodeConfigInvalid for more than 1,000 phrases or a phrase out of format.
func (handle *QuerySuggestions) UpdateBans(ctx context.Context, indexName string, phrases []string) ([]string,
	error) {
	runtime, leave, err := handle.runtime(ctx)
	if err != nil {
		return nil, err
	}
	defer leave()
	return runtime.updateBans(ctx, indexName, phrases)
}

// RemoveQuery bans query for the index called indexName and removes it from
// every suggestions index of the index. It returns how many suggestions
// indexes held the phrase.
func (handle *QuerySuggestions) RemoveQuery(ctx context.Context, indexName string, query string) (int, error) {
	runtime, leave, err := handle.runtime(ctx)
	if err != nil {
		return 0, err
	}
	defer leave()
	return runtime.removeQuery(ctx, indexName, query)
}

// AddSuggestion writes a phrase by hand into the suggestions index of the
// group of suggestion, creating that index where it is missing, and returns
// the name of the suggestions index. The build never removes or recounts a
// phrase that a caller added. It returns CodeConfigInvalid for a group or
// phrase out of format, a count outside 0 to 4,294,967,295, a banned phrase,
// or a new group past MaxGroups.
func (handle *QuerySuggestions) AddSuggestion(ctx context.Context, indexName string,
	suggestion ManualQuerySuggestion) (string, error) {
	if !is.IsGroup(suggestion.Group) {
		return "", suggestionsInvalid("A suggestion needs a group of "+groupFormat, nil)
	}
	if suggestion.Count < 0 || int64(suggestion.Count) > suggestions.MaxManualSuggestionCount {
		return "", suggestionsInvalid("A suggestion's count must be a whole number from 0 to "+
			strconv.FormatInt(suggestions.MaxManualSuggestionCount, 10), nil)
	}
	runtime, leave, err := handle.runtime(ctx)
	if err != nil {
		return "", err
	}
	defer leave()
	return runtime.addSuggestion(ctx, indexName, suggestion)
}

// SuggestionsIndexName returns the name of the suggestions index that serves
// group for the index called indexName, or CodeConfigInvalid for a group out
// of format.
func (handle *QuerySuggestions) SuggestionsIndexName(indexName, group string) (string, error) {
	if !is.IsGroup(group) {
		return "", suggestionsInvalid("A group holds "+groupFormat, nil)
	}
	return suggestionsIndexNameOf(indexName, group), nil
}

func (runtime *suggestionsRuntime) requireAcceptable(indexName string, setting is.QuerySuggestionsSetting) error {
	view, err := runtime.requireSourceView(indexName)
	if err != nil {
		return err
	}
	for _, field := range setting.Fields {
		if fieldType := view.schema[field]; fieldType != string(model.FieldString) &&
			fieldType != string(model.FieldStringList) {
			return suggestionsInvalid(`Field "`+field+`" must be a string or string[] field of the schema`,
				map[string]any{"field": field})
		}
	}
	if !setting.Enabled {
		return nil
	}
	if runtime.scrambler == nil {
		return suggestionsInvalid("This engine has no query suggestions key, so it cannot turn the feature on",
			map[string]any{"indexName": indexName})
	}
	if view.hasSync {
		return suggestionsInvalid(`Index "`+indexName+`" has device sync on, and a device receives the whole index `+
			`of one user while a suggestion comes from the searches of several people`,
			map[string]any{"indexName": indexName})
	}
	return nil
}

func (runtime *suggestionsRuntime) updateSetting(ctx context.Context, indexName string,
	raw model.QuerySuggestionsSetting) error {
	setting, err := storedSettingOf(raw)
	if err != nil {
		return err
	}
	if err := runtime.requireAcceptable(indexName, setting); err != nil {
		return err
	}
	err = runtime.n.updateSuggestionsState(ctx, indexName,
		func(current is.QuerySuggestionsState) (is.QuerySuggestionsState, error) {
			if err := requireSourceState(indexName, current); err != nil {
				return current, err
			}
			current.Setting = &setting
			return current, nil
		})
	if err != nil {
		return err
	}
	if !setting.Enabled {
		if err := runtime.discardHistory(ctx, indexName); err != nil {
			return err
		}
	}
	runtime.timers.rearm(indexName)
	return nil
}

func (runtime *suggestionsRuntime) addSuggestion(ctx context.Context, indexName string,
	suggestion model.ManualQuerySuggestion) (string, error) {
	var name string
	err := runtime.withWriteLock(indexName, func() error {
		view, err := runtime.requireSourceView(indexName)
		if err != nil {
			return err
		}
		stored := is.QuerySuggestionsSetting{}
		if view.state.Setting != nil {
			stored = *view.state.Setting
		}
		setting := suggestions.Resolve(stored)
		accepted, ok := phrase.Accepted(suggestion.Query, setting.PhraseLimits())
		if !ok {
			return suggestionsInvalid("The suggestion is not a phrase that the setting of the index accepts", nil)
		}
		if view.banned(accepted) {
			return suggestionsInvalid("The ban list of the index holds this phrase", map[string]any{"indexName": indexName})
		}
		marked := runtime.n.markedSuggestionIndexes(indexName)
		if _, held := marked[suggestion.Group]; !held && len(marked) >= setting.MaxGroups {
			return suggestionsInvalid(`Index "`+indexName+`" already has `+strconv.Itoa(setting.MaxGroups)+` groups`,
				map[string]any{"indexName": indexName})
		}
		var created []string
		name, err = runtime.ensureSuggestionsIndex(ctx, indexName, suggestion.Group, &created)
		if err != nil {
			return err
		}
		document := suggestionDocument(accepted, float64(suggestion.Count), suggestionOriginManual)
		exists, err := runtime.n.Has(ctx, name, accepted)
		if err != nil {
			return err
		}
		if exists {
			return runtime.n.Update(ctx, name, accepted, document, model.WriteOptions{})
		}
		_, err = runtime.n.Insert(ctx, name, document, "", model.InsertOptions{})
		return err
	})
	return name, err
}

package engine

import (
	"context"
	"sort"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/suggestions"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type mergedHistory struct {
	result    suggestions.MergeResult
	sources   []suggestions.MergedSource
	oldestDay string
}

type buildOutcome struct {
	status    string
	published uint64
	removed   uint64
	discarded uint64
	digest    [suggestions.SourcesDigestBytes]byte
}

func sortedKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func (runtime *suggestionsRuntime) warnFile(indexName string, reason model.QuerySuggestionsWarningReason, file string) {
	runtime.warn(model.QuerySuggestionsWarningEvent{IndexName: indexName, Reason: reason, File: file})
}

func (runtime *suggestionsRuntime) mergeHistory(ctx context.Context, indexName string, setting suggestions.Resolved,
	now time.Time) (mergedHistory, error) {
	view, err := runtime.view(indexName)
	if err != nil {
		return mergedHistory{}, err
	}
	if err := runtime.saveDay(ctx, indexName); err != nil {
		return mergedHistory{}, err
	}
	cutoff := suggestions.CutoffDay(now, setting.RetentionDays)
	merger := suggestions.NewMerger(suggestions.MergeSettings{MinPeople: setting.MinPeople,
		MaxMergePhrases: setting.MaxMergePhrases, MaxGroups: setting.MaxGroups,
		MarkedGroups: sortedKeys(runtime.n.markedSuggestionIndexes(indexName)),
		Fingerprint:  runtime.scrambler.Fingerprint[:], Banned: view.state.BannedQueries,
		MemoryBytes: setting.MergeMemoryBytes})
	keys, err := suggestions.ListHistoryFolder(ctx, runtime.files, indexName)
	if err != nil {
		return mergedHistory{}, narsilerr.New(narsilerr.CodePersistenceLoadFailed,
			"The node cannot read its query history folder", map[string]any{"cause": err.Error()})
	}
	files := make([]suggestions.HistoryFile, 0, len(keys))
	for _, key := range keys {
		if file, isHistory := suggestions.HistoryFileOf(indexName, key); isHistory && file.Day >= cutoff {
			files = append(files, file)
		}
	}
	sort.Slice(files, func(left, right int) bool { return text.CompareCodePoints(files[left].Key, files[right].Key) < 0 })
	merged := mergedHistory{}
	for _, file := range files {
		data, outcome, err := runtime.files.Read(ctx, file.Key)
		if err != nil {
			return mergedHistory{}, err
		}
		if outcome == suggestions.FileMissing {
			continue
		}
		if outcome == suggestions.FileTooLong {
			runtime.warnFile(indexName, model.WarningDamagedFile, file.Key)
			continue
		}
		added, kind, err := merger.AddFile(data, file.Day)
		if err != nil {
			return mergedHistory{}, err
		}
		switch kind {
		case suggestions.OpenedCountsFile:
			merged.sources = append(merged.sources, suggestions.MergedSource{Key: file.Key, SavedAt: added.SavedAt})
			if merged.oldestDay == "" || added.Day < merged.oldestDay {
				merged.oldestDay = added.Day
			}
		case suggestions.OtherKeyFile:
			runtime.warnFile(indexName, model.WarningOtherKey, file.Key)
		default:
			runtime.warnFile(indexName, model.WarningDamagedFile, file.Key)
		}
	}
	merged.result = merger.Result()
	return merged, nil
}

func (runtime *suggestionsRuntime) meetsMinResults(ctx context.Context, indexName string,
	setting suggestions.Resolved, phrase string) (bool, error) {
	if runtime.stopping() {
		return false, instanceShutDown()
	}
	checked, err := runtime.n.Preflight(ctx, indexName, model.QueryParams{Term: phrase, Fields: setting.Fields,
		TermMatch: model.MatchAllTerms()})
	if err != nil {
		return false, err
	}
	pause := time.NewTimer(time.Second / time.Duration(setting.ResultChecksPerSecond))
	defer pause.Stop()
	select {
	case <-pause.C:
	case <-ctx.Done():
		if runtime.stopping() {
			return false, instanceShutDown()
		}
		return false, ctx.Err()
	}
	return checked.Count >= setting.MinResults, nil
}

func (runtime *suggestionsRuntime) groupsToWrite(indexName string, setting suggestions.Resolved,
	result suggestions.MergeResult) ([]string, int) {
	existing := runtime.n.markedSuggestionIndexes(indexName)
	groups := sortedKeys(existing)
	discarded := 0
	for _, group := range sortedKeys(result.Groups) {
		if _, marked := existing[group]; marked {
			continue
		}
		if len(groups) < setting.MaxGroups {
			groups = append(groups, group)
		} else {
			discarded += len(result.Groups[group])
		}
	}
	return groups, discarded
}

func (runtime *suggestionsRuntime) runBuild(ctx context.Context, indexName string, last *suggestions.BuildRecord,
	now time.Time) (buildOutcome, error) {
	setting, err := runtime.enabledSetting(indexName)
	if err != nil {
		return buildOutcome{}, err
	}
	merged, err := runtime.mergeHistory(ctx, indexName, setting, now)
	if err != nil {
		return buildOutcome{}, err
	}
	digest := suggestions.SourcesDigestOf(merged.sources)
	if last != nil && last.SourcesDigest == digest {
		return buildOutcome{status: string(model.BuildSkipped), digest: digest}, nil
	}
	onlyAdd := merged.oldestDay == "" || merged.oldestDay > suggestions.CutoffDay(now, setting.RetentionDays)
	groups, groupsDiscarded := runtime.groupsToWrite(indexName, setting, merged.result)
	due := make([][]suggestions.DuePhrase, len(groups))
	for index, group := range groups {
		for _, candidate := range merged.result.Groups[group] {
			passes, err := runtime.meetsMinResults(ctx, indexName, setting, candidate.Phrase)
			if err != nil {
				return buildOutcome{}, err
			}
			if passes {
				due[index] = append(due[index], candidate)
			}
		}
	}
	outcome := buildOutcome{status: string(model.BuildCompleted), digest: digest,
		discarded: uint64(merged.result.Discarded + groupsDiscarded)}
	var undo []undoStep
	var created []string
	for index, group := range groups {
		err := runtime.withWriteLock(indexName, func() error {
			name, err := runtime.ensureSuggestionsIndex(ctx, indexName, group, &created)
			if err != nil {
				return err
			}
			published, removed, err := runtime.writeGroup(ctx, name, due[index], runtime.bannedNow(indexName), onlyAdd,
				&undo)
			outcome.published += uint64(published)
			outcome.removed += uint64(removed)
			return err
		})
		if err != nil {
			runtime.abandonBuild(indexName, undo, created)
			return buildOutcome{}, err
		}
	}
	return outcome, nil
}

func (runtime *suggestionsRuntime) abandonBuild(indexName string, undo []undoStep, created []string) {
	ctx := context.WithoutCancel(runtime.n.stopping)
	_ = runtime.withWriteLock(indexName, func() error {
		return runtime.undoWrites(ctx, undo, runtime.bannedNow(indexName))
	})
	for _, name := range created {
		_ = runtime.n.DropIndex(ctx, name)
	}
}

func (runtime *suggestionsRuntime) bannedNow(indexName string) map[string]bool {
	banned := map[string]bool{}
	if view, found := runtime.n.suggestionsViewOf(indexName); found {
		for _, phrase := range view.state.BannedQueries {
			banned[phrase] = true
		}
	}
	return banned
}

func (runtime *suggestionsRuntime) previewBuild(ctx context.Context, indexName string, limit int) (
	model.QuerySuggestionsPreview, error) {
	setting, err := runtime.enabledSetting(indexName)
	if err != nil {
		return model.QuerySuggestionsPreview{}, err
	}
	merged, err := runtime.mergeHistory(ctx, indexName, setting, runtime.now())
	if err != nil {
		return model.QuerySuggestionsPreview{}, err
	}
	groups, _ := runtime.groupsToWrite(indexName, setting, merged.result)
	banned := runtime.bannedNow(indexName)
	candidates := make([]model.QuerySuggestionPreviewEntry, 0)
	for _, group := range groups {
		for _, due := range merged.result.Groups[group] {
			if !banned[due.Phrase] {
				candidates = append(candidates, model.QuerySuggestionPreviewEntry{Group: group, Query: due.Phrase,
					Count: int(due.Count)})
			}
		}
	}
	sort.SliceStable(candidates, func(left, right int) bool {
		a, b := candidates[left], candidates[right]
		if a.Count != b.Count {
			return a.Count > b.Count
		}
		if a.Group != b.Group {
			return text.CompareUTF16Units(a.Group, b.Group) < 0
		}
		return text.CompareUTF16Units(a.Query, b.Query) < 0
	})
	checked := map[string]bool{}
	entries := make([]model.QuerySuggestionPreviewEntry, 0)
	next := 0
	for next < len(candidates) && len(entries) < limit {
		candidate := candidates[next]
		next++
		passes, seen := checked[candidate.Query]
		if !seen {
			passes, err = runtime.meetsMinResults(ctx, indexName, setting, candidate.Query)
			if err != nil {
				return model.QuerySuggestionsPreview{}, err
			}
			checked[candidate.Query] = passes
		}
		if passes {
			entries = append(entries, candidate)
		}
	}
	return model.QuerySuggestionsPreview{Entries: entries, Truncated: next < len(candidates)}, nil
}

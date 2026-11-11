package engine

import (
	"context"
	"io"
	"sort"
	"strconv"

	is "github.com/assetcorp/narsil/packages/go/engine/internal/format/indexsettings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist"
	"github.com/assetcorp/narsil/packages/go/engine/internal/suggestions"
)

type stagedHistory struct {
	key string
	day string
}

type historySink struct {
	n         *Narsil
	indexName string
	active    bool
	cutoff    string
	prefix    string
	staged    []stagedHistory
	received  int
	replaces  bool
}

func (n *Narsil) newHistorySink(indexName string) *historySink {
	return &historySink{n: n, indexName: indexName}
}

func (sink *historySink) adopt(entry *indexEntry) (*persist.Handle, error) {
	previous, replaces := sink.n.suggestionsViewOf(sink.indexName)
	sink.replaces = replaces
	if !replaces {
		return entry.handle, nil
	}
	restored := entry.suggestions.current()
	if previous.hasSync && restored.Setting != nil && restored.Setting.Enabled {
		return nil, suggestionsInvalid(`Index "`+sink.indexName+`" has device sync on, and the archive turns popular `+
			`query suggestions on, which a synced index cannot hold`, map[string]any{"indexName": sink.indexName})
	}
	previousBans := previous.state.BannedQueries
	if len(previousBans) > 0 {
		union, err := unionOfBans(previousBans, restored.BannedQueries)
		if err != nil {
			return nil, err
		}
		restored.BannedQueries = union
		entry.suggestions.set(restored)
	}
	return entry.handle, nil
}

func (sink *historySink) open(_ context.Context, restoring persist.Restoring) (persist.HistorySink, error) {
	runtime := sink.n.suggestions
	setting := restoring.Configuration.QuerySuggestions.Setting
	if runtime == nil || runtime.scrambler == nil || setting == nil || !setting.Enabled {
		return sink, nil
	}
	sink.active = true
	sink.cutoff = suggestions.CutoffDay(runtime.now(), suggestions.Resolve(*setting).RetentionDays)
	sink.prefix = suggestions.RestoreStagingPrefix()
	return sink, nil
}

func (sink *historySink) Add(ctx context.Context, body io.Reader) error {
	position := sink.received
	data, err := io.ReadAll(io.LimitReader(body, suggestions.MaxHistoryFileBytes+1))
	if err != nil {
		return narsilerr.Passthrough(err, narsilerr.CodePersistenceLoadFailed, "The query history of the archive cannot be read")
	}
	if !sink.active {
		return ctx.Err()
	}
	sink.received++
	runtime := sink.n.suggestions
	file := suggestions.ArchiveEntryPrefix + strconv.Itoa(position)
	opened, kind, _ := suggestions.OpenCounts(data, "", runtime.scrambler.Fingerprint[:])
	switch kind {
	case suggestions.OtherKeyFile:
		runtime.warnFile(sink.indexName, model.WarningOtherKey, file)
		return nil
	case suggestions.DamagedFile:
		runtime.warnFile(sink.indexName, model.WarningDamagedFile, file)
		return nil
	}
	if opened.Day < sink.cutoff {
		return nil
	}
	stripped, err := opened.WithoutIndexUUID()
	if err != nil {
		runtime.warnFile(sink.indexName, model.WarningDamagedFile, file)
		return nil
	}
	key := sink.prefix + strconv.Itoa(position) + ".nrsl"
	if err := runtime.files.Write(ctx, key, stripped); err != nil {
		return err
	}
	sink.staged = append(sink.staged, stagedHistory{key: key, day: opened.Day})
	return nil
}

func (sink *historySink) Install(context.Context) error { return nil }

func (sink *historySink) Abandon(ctx context.Context) {
	runtime := sink.n.suggestions
	for _, staged := range sink.staged {
		_ = runtime.files.Remove(context.WithoutCancel(ctx), staged.key)
	}
	sink.staged = nil
}

func (sink *historySink) commit(ctx context.Context) error {
	if sink.received == 0 {
		return nil
	}
	runtime := sink.n.suggestions
	if err := runtime.discardHistory(ctx, sink.indexName); err != nil {
		return err
	}
	ordered := append([]stagedHistory(nil), sink.staged...)
	sort.SliceStable(ordered, func(left, right int) bool { return ordered[left].day < ordered[right].day })
	sequences := map[string]int{}
	for _, staged := range ordered {
		data, outcome, err := runtime.files.Read(ctx, staged.key)
		if err != nil {
			return err
		}
		if outcome == suggestions.FileRead {
			sequence := sequences[staged.day]
			sequences[staged.day] = sequence + 1
			if err := runtime.files.Write(ctx, suggestions.RestoredFileKey(sink.indexName, staged.day, sequence),
				data); err != nil {
				return err
			}
		}
		if err := runtime.files.Remove(ctx, staged.key); err != nil {
			return err
		}
	}
	sink.staged = nil
	if runtime.days == nil {
		return nil
	}
	return runtime.days.ForgetHistoryGroups(ctx, sink.indexName)
}

func (n *Narsil) afterSuggestionsRestore(ctx context.Context, sink *historySink, entry *indexEntry) {
	runtime := n.suggestions
	if runtime == nil {
		return
	}
	state := entry.suggestions.current()
	if !sink.replaces {
		if err := n.clearSuggestionLeftovers(ctx, sink.indexName); err != nil {
			n.warnSuggestions(sink.indexName, model.WarningSaveFailed, err.Error())
		}
	}
	if err := runtime.applyRestoredBans(ctx, sink.indexName, state); err != nil {
		n.warnSuggestions(sink.indexName, model.WarningBanRemovalFailed, err.Error())
	}
	var err error
	switch {
	case state.Setting == nil || !state.Setting.Enabled:
		err = runtime.discardHistory(ctx, sink.indexName)
	case runtime.scrambler == nil:
		n.warnSuggestions(sink.indexName, model.WarningNoKey, "")
	default:
		err = sink.commit(ctx)
	}
	if err != nil {
		n.warnSuggestions(sink.indexName, model.WarningSaveFailed, err.Error())
	}
	runtime.timers.rearm(sink.indexName)
}

func (runtime *suggestionsRuntime) applyRestoredBans(ctx context.Context, indexName string,
	state is.QuerySuggestionsState) error {
	if len(state.BannedQueries) > 0 {
		for _, name := range runtime.n.suggestionIndexesOf(indexName) {
			if _, err := runtime.n.suggestionsRemove(ctx, name, state.BannedQueries); err != nil {
				return err
			}
		}
	}
	marker := state.Source
	if marker == nil || marker.Index == indexName {
		return nil
	}
	view, found := runtime.n.suggestionsViewOf(marker.Index)
	if !found || len(view.state.BannedQueries) == 0 {
		return nil
	}
	_, err := runtime.n.suggestionsRemove(ctx, indexName, view.state.BannedQueries)
	return err
}

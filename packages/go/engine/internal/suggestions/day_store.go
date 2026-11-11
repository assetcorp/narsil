package suggestions

import (
	"context"
	"sort"
	"sync"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

type Warn func(event model.QuerySuggestionsWarningEvent)

type indexDays struct {
	turn    chan struct{}
	users   int
	current *DayCounts
	unsaved []*DayCounts
	warned  map[string]bool
	held    *heldGroups
}

type DayStore struct {
	files     Files
	scrambler *Scrambler
	warn      Warn
	now       func() time.Time

	mu      sync.Mutex
	indexes map[string]*indexDays
}

func NewDayStore(files Files, scrambler *Scrambler, warn Warn, now func() time.Time) *DayStore {
	return &DayStore{files: files, scrambler: scrambler, warn: warn, now: now, indexes: map[string]*indexDays{}}
}

func (store *DayStore) inTurn(ctx context.Context, indexName string, work func(state *indexDays) error) error {
	store.mu.Lock()
	state, found := store.indexes[indexName]
	if !found {
		state = &indexDays{turn: make(chan struct{}, 1), warned: map[string]bool{}}
		store.indexes[indexName] = state
	}
	state.users++
	store.mu.Unlock()
	defer store.leave(indexName, state)
	select {
	case state.turn <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-state.turn }()
	return work(state)
}

func (store *DayStore) leave(indexName string, state *indexDays) {
	store.mu.Lock()
	defer store.mu.Unlock()
	state.users--
	if state.users == 0 && state.current == nil && len(state.unsaved) == 0 && state.held == nil &&
		len(state.warned) == 0 && store.indexes[indexName] == state {
		delete(store.indexes, indexName)
	}
}

func (store *DayStore) HasUnsaved(indexName string) bool {
	unsaved := false
	_ = store.inTurn(context.Background(), indexName, func(state *indexDays) error {
		unsaved = (state.current != nil && state.current.IsChanged()) || len(state.unsaved) > 0
		return nil
	})
	return unsaved
}

func (store *DayStore) Indexes() []string {
	store.mu.Lock()
	defer store.mu.Unlock()
	names := make([]string, 0, len(store.indexes))
	for name := range store.indexes {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

type CountRequest struct {
	Group        string
	Phrase       string
	Person       string
	GroupAllowed func(known map[string]bool) bool
	StillEnabled func() bool
	IsBanned     func() bool
}

type CountResult string

const (
	CountBanned  CountResult = "banned"
	CountStopped CountResult = ""
)

func limitsOf(setting Resolved) DayLimits {
	return DayLimits{MinPeople: setting.MinPeople, MaxPhrasesPerDay: setting.MaxPhrasesPerDay,
		MaxPhrasesPerPerson: setting.MaxPhrasesPerPerson, MaxPeoplePerDay: setting.MaxPeoplePerDay,
		MaxGroups: setting.MaxGroups}
}

func (store *DayStore) Count(ctx context.Context, indexName string, setting Resolved, now time.Time,
	request CountRequest) (CountResult, error) {
	var result CountResult
	err := store.inTurn(ctx, indexName, func(state *indexDays) error {
		if !request.StillEnabled() {
			result = CountStopped
			return nil
		}
		if request.IsBanned() {
			result = CountBanned
			return nil
		}
		counts, err := store.currentDay(ctx, indexName, state, setting, now)
		if err != nil {
			return err
		}
		allowed := counts.HasGroup(request.Group)
		if !allowed {
			known, err := store.knownGroups(ctx, indexName, state, counts, CutoffDay(now, setting.RetentionDays))
			if err != nil {
				return err
			}
			allowed = request.GroupAllowed(known)
		}
		outcome := counts.Count(request.Group, request.Phrase, store.scrambler.Scramble(request.Person), allowed)
		if outcome == CountPhraseLimit || outcome == CountPeopleLimit {
			store.warnLimit(indexName, state, counts.Day, outcome)
		}
		result = CountResult(outcome)
		return nil
	})
	return result, err
}

func (store *DayStore) Save(ctx context.Context, indexName string) error {
	return store.inTurn(ctx, indexName, func(state *indexDays) error {
		store.saveNow(ctx, indexName, state)
		return nil
	})
}

func (store *DayStore) Retire(ctx context.Context, indexName, today string) error {
	return store.inTurn(ctx, indexName, func(state *indexDays) error {
		store.saveNow(ctx, indexName, state)
		counts := state.current
		if counts == nil || counts.Day >= today || counts.IsChanged() {
			return nil
		}
		state.noteHistory(counts.Day, counts.GroupNames())
		state.current = nil
		return nil
	})
}

func (store *DayStore) ForgetHistoryGroups(ctx context.Context, indexName string) error {
	return store.inTurn(ctx, indexName, func(state *indexDays) error {
		state.held = nil
		return nil
	})
}

func (store *DayStore) Discard(ctx context.Context, indexName string) error {
	return store.inTurn(ctx, indexName, func(state *indexDays) error {
		state.current, state.unsaved, state.held = nil, nil, nil
		state.warned = map[string]bool{}
		return nil
	})
}

func (store *DayStore) knownGroups(ctx context.Context, indexName string, state *indexDays, counts *DayCounts,
	cutoff string) (map[string]bool, error) {
	known := map[string]bool{}
	for _, group := range counts.GroupNames() {
		known[group] = true
	}
	for _, unsaved := range state.unsaved {
		for _, group := range unsaved.GroupNames() {
			known[group] = true
		}
	}
	held, err := state.historyGroups(ctx, store.files, store.scrambler.Fingerprint[:], indexName, cutoff)
	if err != nil {
		return nil, err
	}
	for group := range held {
		known[group] = true
	}
	return known, nil
}

func (store *DayStore) warnLimit(indexName string, state *indexDays, day string, reason CountOutcome) {
	mark := day + ":" + string(reason)
	if state.warned[mark] {
		return
	}
	state.warned[mark] = true
	store.warn(model.QuerySuggestionsWarningEvent{IndexName: indexName,
		Reason: model.QuerySuggestionsWarningReason(reason)})
}

func (store *DayStore) currentDay(ctx context.Context, indexName string, state *indexDays, setting Resolved,
	now time.Time) (*DayCounts, error) {
	day := DayOf(now)
	limits := limitsOf(setting)
	current := state.current
	if current != nil && current.Day == day && current.Limits == limits {
		return current, nil
	}
	if current != nil {
		store.saveNow(ctx, indexName, state)
		if current.IsChanged() {
			if current.Day == day {
				return current, nil
			}
			state.unsaved = append(state.unsaved, current)
		}
		state.noteHistory(current.Day, current.GroupNames())
		state.current = nil
	}
	loaded, err := store.load(ctx, indexName, day, limits)
	if err != nil {
		return nil, err
	}
	state.current = loaded
	return loaded, nil
}

func (store *DayStore) load(ctx context.Context, indexName, day string, limits DayLimits) (*DayCounts, error) {
	counts := NewDayCounts(day, limits)
	key := DayFileKey(indexName, day)
	data, outcome, err := store.files.Read(ctx, key)
	if err != nil {
		return nil, err
	}
	switch outcome {
	case FileMissing:
		return counts, nil
	case FileTooLong:
		store.warn(model.QuerySuggestionsWarningEvent{IndexName: indexName, Reason: model.WarningDamagedFile, File: key})
		return counts, nil
	}
	opened, kind, _ := OpenCounts(data, day, store.scrambler.Fingerprint[:])
	if kind != OpenedCountsFile {
		reason := model.WarningDamagedFile
		if kind == OtherKeyFile {
			reason = model.WarningOtherKey
		}
		store.warn(model.QuerySuggestionsWarningEvent{IndexName: indexName, Reason: reason, File: key})
		return counts, nil
	}
	opened.Visit(func(group, phrase string, count uint64, people [][]byte) {
		counts.RestorePhrase(group, phrase, count, people)
	})
	return counts, nil
}

func (store *DayStore) saveNow(ctx context.Context, indexName string, state *indexDays) {
	if len(state.unsaved) > 0 {
		still := make([]*DayCounts, 0, len(state.unsaved))
		for _, counts := range state.unsaved {
			store.write(ctx, indexName, counts)
			if counts.IsChanged() {
				still = append(still, counts)
			}
		}
		state.unsaved = still
	}
	if state.current != nil {
		store.write(ctx, indexName, state.current)
	}
}

func (store *DayStore) write(ctx context.Context, indexName string, counts *DayCounts) {
	if !counts.IsChanged() {
		return
	}
	data, err := EncodeCounts(counts, store.scrambler.Fingerprint[:], uint64(store.now().UnixMilli()))
	if err == nil {
		counts.MarkSaved()
		err = store.files.Write(ctx, DayFileKey(indexName, counts.Day), data)
	}
	if err != nil {
		counts.MarkChanged()
		store.warn(model.QuerySuggestionsWarningEvent{IndexName: indexName, Reason: model.WarningSaveFailed,
			Message: err.Error()})
	}
}

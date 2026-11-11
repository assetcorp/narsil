package engine

import (
	"context"
	"sort"
	"sync"
	"time"

	is "github.com/assetcorp/narsil/packages/go/engine/internal/format/indexsettings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/suggestions"
)

type suggestionTimers struct {
	runtime *suggestionsRuntime

	mu        sync.Mutex
	stopped   bool
	saves     map[string]*time.Timer
	schedules map[string]*time.Timer
	sweep     *time.Timer
	midnight  *time.Timer
}

func newSuggestionTimers(runtime *suggestionsRuntime) *suggestionTimers {
	return &suggestionTimers{runtime: runtime, saves: map[string]*time.Timer{}, schedules: map[string]*time.Timer{}}
}

func clampedDelay(delay time.Duration) time.Duration {
	return min(max(delay, 0), suggestions.MaxTimerDelayMS*time.Millisecond)
}

func (timers *suggestionTimers) saveSoon(indexName string, interval time.Duration) {
	timers.mu.Lock()
	defer timers.mu.Unlock()
	if timers.stopped || timers.saves[indexName] != nil {
		return
	}
	var timer *time.Timer
	timer = time.AfterFunc(interval, func() {
		timers.mu.Lock()
		if timers.saves[indexName] == timer {
			delete(timers.saves, indexName)
		}
		timers.mu.Unlock()
		timers.runtime.background(func(ctx context.Context) {
			if timers.runtime.saveDay(ctx, indexName) == nil && timers.runtime.days.HasUnsaved(indexName) {
				timers.saveSoon(indexName, interval)
			}
		})
	})
	timers.saves[indexName] = timer
}

func (timers *suggestionTimers) forgetSave(indexName string) {
	timers.mu.Lock()
	defer timers.mu.Unlock()
	if timer := timers.saves[indexName]; timer != nil {
		timer.Stop()
	}
	delete(timers.saves, indexName)
}

func (timers *suggestionTimers) forgetIndex(indexName string) {
	timers.forgetSave(indexName)
	timers.mu.Lock()
	defer timers.mu.Unlock()
	if timer := timers.schedules[indexName]; timer != nil {
		timer.Stop()
	}
	delete(timers.schedules, indexName)
}

func (timers *suggestionTimers) enabledIndexes() []string {
	names := make([]string, 0)
	for name, state := range timers.runtime.n.suggestionsStates() {
		if state.Setting != nil && state.Setting.Enabled {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}

func (timers *suggestionTimers) start(ctx context.Context) error {
	_ = suggestions.RemoveRestoreLeftovers(ctx, timers.runtime.files)
	timers.sweepNow(ctx)
	timers.armSweep()
	timers.armMidnight()
	for _, indexName := range timers.enabledIndexes() {
		timers.startMissedBuild(ctx, indexName)
		timers.rearm(indexName)
	}
	return nil
}

func (timers *suggestionTimers) stop() {
	timers.mu.Lock()
	defer timers.mu.Unlock()
	timers.stopped = true
	for _, timer := range timers.saves {
		timer.Stop()
	}
	for _, timer := range timers.schedules {
		timer.Stop()
	}
	clear(timers.saves)
	clear(timers.schedules)
	for _, timer := range []*time.Timer{timers.sweep, timers.midnight} {
		if timer != nil {
			timer.Stop()
		}
	}
	timers.sweep, timers.midnight = nil, nil
}

func scheduleOf(setting *is.QuerySuggestionsSetting) (*suggestions.Schedule, *time.Location, bool) {
	if setting == nil || !setting.Enabled {
		return nil, nil, false
	}
	resolved := suggestions.Resolve(*setting)
	if resolved.Schedule == is.ScheduleOff {
		return nil, nil, false
	}
	schedule, parsed := suggestions.ParseSchedule(resolved.Schedule)
	zone, err := time.LoadLocation(resolved.TimeZone)
	if !parsed || err != nil {
		return nil, nil, false
	}
	return schedule, zone, true
}

func (timers *suggestionTimers) nextBuildAt(indexName string) (time.Time, bool) {
	if timers.runtime.scrambler == nil {
		return time.Time{}, false
	}
	schedule, zone, scheduled := scheduleOf(timers.runtime.settingOf(indexName))
	if !scheduled {
		return time.Time{}, false
	}
	return schedule.NextMatchAfter(zone, timers.runtime.now())
}

func (timers *suggestionTimers) rearm(indexName string) {
	timers.mu.Lock()
	if previous := timers.schedules[indexName]; previous != nil {
		previous.Stop()
	}
	delete(timers.schedules, indexName)
	stopped := timers.stopped
	timers.mu.Unlock()
	if stopped {
		return
	}
	if at, scheduled := timers.nextBuildAt(indexName); scheduled {
		timers.arm(indexName, at)
	}
}

func (timers *suggestionTimers) arm(indexName string, at time.Time) {
	timers.mu.Lock()
	defer timers.mu.Unlock()
	if timers.stopped {
		return
	}
	var timer *time.Timer
	timer = time.AfterFunc(clampedDelay(at.Sub(timers.runtime.now())), func() {
		timers.mu.Lock()
		current := timers.schedules[indexName] == timer
		if current {
			delete(timers.schedules, indexName)
		}
		stopped := timers.stopped
		timers.mu.Unlock()
		if !current || stopped {
			return
		}
		if timers.runtime.now().Before(at) {
			timers.arm(indexName, at)
			return
		}
		timers.startBuild(indexName, model.BuildTriggerSchedule)
		timers.rearm(indexName)
	})
	timers.schedules[indexName] = timer
}

func (timers *suggestionTimers) startBuild(indexName string, trigger model.QuerySuggestionsBuildTrigger) {
	_, _ = timers.runtime.builds.begin(indexName, trigger)
}

func (timers *suggestionTimers) startMissedBuild(ctx context.Context, indexName string) {
	schedule, zone, scheduled := scheduleOf(timers.runtime.settingOf(indexName))
	if !scheduled {
		return
	}
	latest, found := schedule.LatestMatchAtOrBefore(zone, timers.runtime.now())
	if !found {
		return
	}
	record, held := timers.runtime.readBuildRecord(ctx, indexName)
	completedSince := held && (record.Status == string(model.BuildCompleted) ||
		record.Status == string(model.BuildSkipped)) && int64(record.StartedAt) >= latest.UnixMilli()
	if !completedSince {
		timers.startBuild(indexName, model.BuildTriggerMissed)
	}
}

func (timers *suggestionTimers) armSweep() {
	timers.mu.Lock()
	defer timers.mu.Unlock()
	if timers.stopped {
		return
	}
	timers.sweep = time.AfterFunc(suggestions.HistorySweepIntervalMS*time.Millisecond, func() {
		timers.runtime.background(func(ctx context.Context) {
			timers.sweepNow(ctx)
			timers.armSweep()
		})
	})
}

func (timers *suggestionTimers) armMidnight() {
	timers.mu.Lock()
	defer timers.mu.Unlock()
	if timers.stopped {
		return
	}
	now := timers.runtime.now()
	next := now.UTC().Truncate(24 * time.Hour).Add(24 * time.Hour)
	timers.midnight = time.AfterFunc(clampedDelay(next.Sub(now)), func() {
		timers.runtime.background(func(ctx context.Context) {
			timers.retireDays(ctx)
			timers.armMidnight()
		})
	})
}

func (timers *suggestionTimers) retireDays(ctx context.Context) {
	days := timers.runtime.days
	if days == nil {
		return
	}
	today := suggestions.DayOf(timers.runtime.now())
	for _, indexName := range days.Indexes() {
		_ = days.Retire(ctx, indexName, today)
	}
}

func (timers *suggestionTimers) sweepNow(ctx context.Context) {
	runtime := timers.runtime
	now := runtime.now()
	states := runtime.n.suggestionsStates()
	names := make([]string, 0, len(states))
	for name := range states {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, indexName := range names {
		state := states[indexName]
		if state.Setting == nil || !state.Setting.Enabled {
			if state.Source == nil {
				_ = suggestions.RemoveHistoryFolder(ctx, runtime.files, indexName)
			}
			continue
		}
		cutoff := suggestions.CutoffDay(now, suggestions.Resolve(*state.Setting).RetentionDays)
		keys, err := suggestions.ListHistoryFolder(ctx, runtime.files, indexName)
		if err != nil {
			continue
		}
		for _, key := range keys {
			if file, isHistory := suggestions.HistoryFileOf(indexName, key); isHistory && file.Day < cutoff {
				_ = runtime.files.Remove(ctx, key)
			}
		}
	}
}

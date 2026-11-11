package suggestions

import (
	"context"
	"time"
)

func DayOf(instant time.Time) string { return instant.UTC().Format(dayLayout) }

func CutoffDay(now time.Time, retentionDays int) string {
	return DayOf(now.Add(-time.Duration(retentionDays) * DayMS * time.Millisecond))
}

type heldGroups struct {
	cutoff    string
	newestDay map[string]string
}

func (held *heldGroups) note(day string, groups []string) {
	if day < held.cutoff {
		return
	}
	for _, group := range groups {
		if newest, found := held.newestDay[group]; !found || newest < day {
			held.newestDay[group] = day
		}
	}
}

func loadHistoryGroups(ctx context.Context, files Files, fingerprint []byte, indexName, cutoff string) (
	map[string]string, error) {
	newestDay := map[string]string{}
	keys, err := ListHistoryFolder(ctx, files, indexName)
	if err != nil {
		return nil, err
	}
	for _, key := range keys {
		file, isHistory := HistoryFileOf(indexName, key)
		if !isHistory || file.Day < cutoff {
			continue
		}
		data, outcome, err := files.Read(ctx, key)
		if err != nil {
			return nil, err
		}
		if outcome != FileRead {
			continue
		}
		opened, kind, _ := OpenCounts(data, file.Day, fingerprint)
		if kind != OpenedCountsFile {
			continue
		}
		for _, group := range opened.GroupNames() {
			if newest, found := newestDay[group]; !found || newest < file.Day {
				newestDay[group] = file.Day
			}
		}
	}
	return newestDay, nil
}

func (state *indexDays) historyGroups(ctx context.Context, files Files, fingerprint []byte, indexName, cutoff string) (
	map[string]string, error) {
	held := state.held
	if held != nil && held.cutoff <= cutoff {
		if held.cutoff < cutoff {
			for group, day := range held.newestDay {
				if day < cutoff {
					delete(held.newestDay, group)
				}
			}
			held.cutoff = cutoff
		}
		return held.newestDay, nil
	}
	newestDay, err := loadHistoryGroups(ctx, files, fingerprint, indexName, cutoff)
	if err != nil {
		return nil, err
	}
	state.held = &heldGroups{cutoff: cutoff, newestDay: newestDay}
	return newestDay, nil
}

func (state *indexDays) noteHistory(day string, groups []string) {
	if state.held != nil {
		state.held.note(day, groups)
	}
}

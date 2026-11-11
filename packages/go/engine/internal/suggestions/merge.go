package suggestions

import (
	"sort"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type MergeSettings struct {
	MinPeople       int
	MaxMergePhrases int
	MaxGroups       int
	MarkedGroups    []string
	Fingerprint     []byte
	Banned          []string
	MemoryBytes     int64
}

type DuePhrase struct {
	Phrase string
	Count  uint64
}

type MergeResult struct {
	Groups    map[string][]DuePhrase
	Discarded int
}

type mergeKey struct {
	group  string
	phrase string
}

type mergeEntry struct {
	count  uint64
	people map[ScrambledID]struct{}
}

type Merger struct {
	settings MergeSettings
	banned   map[string]bool
	entries  map[mergeKey]*mergeEntry
	order    []mergeKey
	groups   map[string]bool
	bytes    int64
	discard  int
}

func NewMerger(settings MergeSettings) *Merger {
	merger := &Merger{settings: settings, banned: map[string]bool{}, entries: map[mergeKey]*mergeEntry{},
		groups: map[string]bool{}}
	for _, phrase := range settings.Banned {
		merger.banned[phrase] = true
	}
	for _, group := range settings.MarkedGroups {
		merger.groups[group] = true
	}
	return merger
}

type MergedFile struct {
	Day     string
	SavedAt uint64
}

func (merger *Merger) charge(bytes int64) error {
	merger.bytes += bytes
	if merger.bytes <= merger.settings.MemoryBytes {
		return nil
	}
	return narsilerr.New(narsilerr.CodeWorkerActionFailed, "The query suggestions merge failed: it needs more than "+
		strconv.FormatInt(merger.settings.MemoryBytes, 10)+" bytes, the mergeMemoryBytes of the index", nil)
}

func (merger *Merger) AddFile(data []byte, expectedDay string) (MergedFile, OpenKind, error) {
	opened, kind, _ := OpenCounts(data, expectedDay, merger.settings.Fingerprint)
	if kind != OpenedCountsFile {
		return MergedFile{}, kind, nil
	}
	var failure error
	opened.Visit(func(group, phrase string, count uint64, people [][]byte) {
		if failure == nil {
			failure = merger.addPhrase(group, phrase, count, people)
		}
	})
	if failure != nil {
		return MergedFile{}, OpenedCountsFile, failure
	}
	return MergedFile{Day: opened.Day, SavedAt: opened.SavedAt}, OpenedCountsFile, nil
}

func (merger *Merger) addPhrase(group, phrase string, count uint64, people [][]byte) error {
	if merger.banned[phrase] {
		return nil
	}
	key := mergeKey{group: group, phrase: phrase}
	entry, found := merger.entries[key]
	if !found {
		newGroup := !merger.groups[group]
		if (newGroup && len(merger.groups) >= merger.settings.MaxGroups) ||
			len(merger.entries) >= merger.settings.MaxMergePhrases {
			merger.discard++
			return nil
		}
		if err := merger.charge(int64(len(group)+len(phrase)) + MergeEntryOverheadBytes); err != nil {
			return err
		}
		if newGroup {
			merger.groups[group] = true
		}
		entry = &mergeEntry{people: map[ScrambledID]struct{}{}}
		merger.entries[key] = entry
		merger.order = append(merger.order, key)
	}
	entry.count += count
	if entry.people == nil {
		return nil
	}
	for _, raw := range people {
		var id ScrambledID
		copy(id[:], raw)
		if _, held := entry.people[id]; !held {
			if err := merger.charge(MergePersonBytes); err != nil {
				return err
			}
			entry.people[id] = struct{}{}
		}
		if len(entry.people) >= merger.settings.MinPeople {
			merger.bytes -= int64(len(entry.people)) * MergePersonBytes
			entry.people = nil
			return nil
		}
	}
	return nil
}

func (merger *Merger) Result() MergeResult {
	groups := map[string][]DuePhrase{}
	for _, key := range merger.order {
		entry := merger.entries[key]
		if entry.people != nil {
			continue
		}
		groups[key.group] = append(groups[key.group], DuePhrase{Phrase: key.phrase, Count: entry.count})
	}
	for _, list := range groups {
		sort.SliceStable(list, func(left, right int) bool {
			if list[left].Count != list[right].Count {
				return list[left].Count > list[right].Count
			}
			return text.CompareUTF16Units(list[left].Phrase, list[right].Phrase) < 0
		})
	}
	return MergeResult{Groups: groups, Discarded: merger.discard}
}

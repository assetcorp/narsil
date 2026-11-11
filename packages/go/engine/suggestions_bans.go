package engine

import (
	"context"
	"slices"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	is "github.com/assetcorp/narsil/packages/go/engine/internal/format/indexsettings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/suggestions"
	"github.com/assetcorp/narsil/packages/go/engine/internal/suggestions/phrase"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

func requireBansWithinLimits(phrases []string) error {
	if len(phrases) > is.MaxBannedPhrases {
		return suggestionsInvalid("A ban list holds at most "+strconv.Itoa(is.MaxBannedPhrases)+" phrases",
			map[string]any{"phrases": len(phrases)})
	}
	encoded, err := codec.Marshal(phrases, codec.EncodeOptions{})
	if err != nil || len(encoded) > is.MaxBanListBytes {
		return suggestionsInvalid("A ban list must encode to at most "+strconv.Itoa(is.MaxBanListBytes)+" bytes", nil)
	}
	return nil
}

func normaliseBan(raw string) (string, error) {
	accepted, ok := phrase.Accepted(raw, suggestions.BanLimits)
	if !ok {
		return "", suggestionsInvalid("A banned phrase must hold up to "+strconv.Itoa(is.MaxBannedPhraseCodePoints)+
			" letters, digits, spaces, hyphens, and apostrophes", nil)
	}
	return accepted, nil
}

func banListFromInput(raw []string) ([]string, error) {
	if len(raw) > is.MaxBannedPhrases {
		return nil, suggestionsInvalid("A ban list holds at most "+strconv.Itoa(is.MaxBannedPhrases)+" phrases",
			map[string]any{"phrases": len(raw)})
	}
	seen := map[string]bool{}
	phrases := make([]string, 0, len(raw))
	for _, entry := range raw {
		normalised, err := normaliseBan(entry)
		if err != nil {
			return nil, err
		}
		if !seen[normalised] {
			seen[normalised] = true
			phrases = append(phrases, normalised)
		}
	}
	return phrases, requireBansWithinLimits(phrases)
}

func unionOfBans(first, second []string) ([]string, error) {
	seen := map[string]bool{}
	union := make([]string, 0, len(first)+len(second))
	for _, phrase := range slices.Concat(first, second) {
		if !seen[phrase] {
			seen[phrase] = true
			union = append(union, phrase)
		}
	}
	return union, requireBansWithinLimits(union)
}

func (runtime *suggestionsRuntime) requireSourceView(indexName string) (suggestionsView, error) {
	view, err := runtime.view(indexName)
	if err != nil {
		return suggestionsView{}, err
	}
	if view.state.Source != nil {
		return suggestionsView{}, suggestionsInvalid(`Index "`+indexName+
			`" is a suggestions index, so it takes no query suggestions of its own`, map[string]any{"indexName": indexName})
	}
	if text.UTF16Length(indexName) > is.MaxSourceIndexNameLength {
		return suggestionsView{}, suggestionsInvalid(`Index "`+indexName+`" has a name longer than `+
			strconv.Itoa(is.MaxSourceIndexNameLength)+
			` characters, which leaves no room for the names of its suggestions indexes`,
			map[string]any{"indexName": indexName})
	}
	return view, nil
}

func requireSourceState(indexName string, state is.QuerySuggestionsState) error {
	if state.Source != nil {
		return suggestionsInvalid(`Index "`+indexName+
			`" is a suggestions index, so it takes no query suggestions of its own`, map[string]any{"indexName": indexName})
	}
	return nil
}

func (runtime *suggestionsRuntime) banPhrases(ctx context.Context, indexName string,
	next func(current []string) []string) ([]string, []string, error) {
	if _, err := runtime.requireSourceView(indexName); err != nil {
		return nil, nil, err
	}
	var stored, added []string
	err := runtime.n.updateSuggestionsState(ctx, indexName,
		func(current is.QuerySuggestionsState) (is.QuerySuggestionsState, error) {
			if err := requireSourceState(indexName, current); err != nil {
				return current, err
			}
			stored = next(current.BannedQueries)
			if err := requireBansWithinLimits(stored); err != nil {
				return current, err
			}
			before := map[string]bool{}
			for _, phrase := range current.BannedQueries {
				before[phrase] = true
			}
			added = nil
			for _, phrase := range stored {
				if !before[phrase] {
					added = append(added, phrase)
				}
			}
			current.BannedQueries = stored
			if len(stored) == 0 {
				current.BannedQueries = nil
			}
			return current, nil
		})
	return stored, added, err
}

func (runtime *suggestionsRuntime) removeFromSuggestions(ctx context.Context, indexName string,
	phrases []string) (int, error) {
	holders := 0
	if len(phrases) == 0 {
		return holders, nil
	}
	marked := runtime.n.markedSuggestionIndexes(indexName)
	for _, group := range sortedKeys(marked) {
		removed, err := runtime.n.suggestionsRemove(ctx, marked[group], phrases)
		if err != nil {
			return holders, err
		}
		if removed > 0 {
			holders++
		}
	}
	return holders, nil
}

func (runtime *suggestionsRuntime) updateBans(ctx context.Context, indexName string, raw []string) ([]string, error) {
	phrases, err := banListFromInput(raw)
	if err != nil {
		return nil, err
	}
	var stored []string
	err = runtime.withWriteLock(indexName, func() error {
		held, added, err := runtime.banPhrases(ctx, indexName, func([]string) []string { return phrases })
		if err != nil {
			return err
		}
		stored = held
		_, err = runtime.removeFromSuggestions(ctx, indexName, added)
		return err
	})
	if stored == nil {
		stored = []string{}
	}
	return stored, err
}

func (runtime *suggestionsRuntime) removeQuery(ctx context.Context, indexName string, raw string) (int, error) {
	normalised, err := normaliseBan(raw)
	if err != nil {
		return 0, err
	}
	holders := 0
	err = runtime.withWriteLock(indexName, func() error {
		_, _, err := runtime.banPhrases(ctx, indexName, func(current []string) []string {
			if slices.Contains(current, normalised) {
				return slices.Clone(current)
			}
			return append(slices.Clone(current), normalised)
		})
		if err != nil {
			return err
		}
		holders, err = runtime.removeFromSuggestions(ctx, indexName, []string{normalised})
		return err
	})
	return holders, err
}

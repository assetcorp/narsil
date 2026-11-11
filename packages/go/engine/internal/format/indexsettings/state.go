package indexsettings

import "github.com/assetcorp/narsil/packages/go/engine/internal/codec"

type QuerySuggestionsState struct {
	Setting       *QuerySuggestionsSetting
	BannedQueries []string
	Source        *QuerySuggestionsSource
}

func ReadQuerySuggestionsState(record map[string]any, keyCase Case) (QuerySuggestionsState, error) {
	state := QuerySuggestionsState{}
	if raw, present := Present(record, keyCase.Key("query_suggestions", "querySuggestions")); present {
		setting, err := ReadQuerySuggestionsSetting(raw, keyCase)
		if err != nil {
			return QuerySuggestionsState{}, err
		}
		state.Setting = &setting
	}
	if raw, present := Present(record, keyCase.Key("banned_queries", "bannedQueries")); present {
		banned, err := ReadBanList(raw)
		if err != nil {
			return QuerySuggestionsState{}, err
		}
		if len(banned) > 0 {
			state.BannedQueries = banned
		}
	}
	if raw, present := Present(record, keyCase.Key("query_suggestions_source", "querySuggestionsSource")); present {
		source, err := ReadQuerySuggestionsSource(raw)
		if err != nil {
			return QuerySuggestionsState{}, err
		}
		state.Source = &source
	}
	return state, nil
}

func (state QuerySuggestionsState) Put(entries *codec.OrderedMap, keyCase Case) {
	if state.Setting != nil {
		Put(entries, keyCase.Key("query_suggestions", "querySuggestions"), state.Setting.Value(keyCase))
	}
	if len(state.BannedQueries) > 0 {
		Put(entries, keyCase.Key("banned_queries", "bannedQueries"), Texts(state.BannedQueries))
	}
	if state.Source != nil {
		Put(entries, keyCase.Key("query_suggestions_source", "querySuggestionsSource"), state.Source.Value())
	}
}

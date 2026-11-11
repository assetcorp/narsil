package indexsettings

import (
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type QuerySuggestionsSetting struct {
	Enabled               bool
	Fields                []string
	MinPeople             model.Optional[int64]
	MinResults            model.Optional[int64]
	RetentionDays         model.Optional[int64]
	MaxPhrasesPerDay      model.Optional[int64]
	MaxPhrasesPerPerson   model.Optional[int64]
	MaxPeoplePerDay       model.Optional[int64]
	MaxGroups             model.Optional[int64]
	MaxLength             model.Optional[int64]
	MinLetters            model.Optional[int64]
	MaxWords              model.Optional[int64]
	MaxDigits             model.Optional[int64]
	MaxMergePhrases       model.Optional[int64]
	MergeMemoryBytes      model.Optional[int64]
	SaveIntervalMS        model.Optional[int64]
	ResultChecksPerSecond model.Optional[int64]
	Schedule              model.Optional[string]
	TimeZone              model.Optional[string]
}

type settingRange struct {
	camel    string
	snake    string
	fallback int64
	minimum  int64
	maximum  int64
	maxOf    int
	slot     func(*QuerySuggestionsSetting) *model.Optional[int64]
}

const noRangeReference = -1

const maxLengthRange = 7

var settingRanges = []settingRange{
	{"minPeople", "min_people", DefaultMinPeople, MinMinPeople, MaxMinPeople, noRangeReference,
		func(setting *QuerySuggestionsSetting) *model.Optional[int64] { return &setting.MinPeople }},
	{"minResults", "min_results", DefaultMinResults, MinMinResults, MaxMinResults, noRangeReference,
		func(setting *QuerySuggestionsSetting) *model.Optional[int64] { return &setting.MinResults }},
	{"retentionDays", "retention_days", DefaultRetentionDays, MinRetentionDays, MaxRetentionDays, noRangeReference,
		func(setting *QuerySuggestionsSetting) *model.Optional[int64] { return &setting.RetentionDays }},
	{"maxPhrasesPerDay", "max_phrases_per_day", DefaultMaxPhrasesPerDay, 1, MaxMaxPhrasesPerDay, noRangeReference,
		func(setting *QuerySuggestionsSetting) *model.Optional[int64] { return &setting.MaxPhrasesPerDay }},
	{"maxPhrasesPerPerson", "max_phrases_per_person", DefaultMaxPhrasesPerPerson, 1, MaxMaxPhrasesPerPerson, noRangeReference,
		func(setting *QuerySuggestionsSetting) *model.Optional[int64] { return &setting.MaxPhrasesPerPerson }},
	{"maxPeoplePerDay", "max_people_per_day", DefaultMaxPeoplePerDay, 1, MaxMaxPeoplePerDay, noRangeReference,
		func(setting *QuerySuggestionsSetting) *model.Optional[int64] { return &setting.MaxPeoplePerDay }},
	{"maxGroups", "max_groups", DefaultMaxGroups, 1, MaxMaxGroups, noRangeReference,
		func(setting *QuerySuggestionsSetting) *model.Optional[int64] { return &setting.MaxGroups }},
	{"maxLength", "max_length", DefaultMaxLength, 1, MaxMaxLength, noRangeReference,
		func(setting *QuerySuggestionsSetting) *model.Optional[int64] { return &setting.MaxLength }},
	{"minLetters", "min_letters", DefaultMinLetters, 1, 0, maxLengthRange,
		func(setting *QuerySuggestionsSetting) *model.Optional[int64] { return &setting.MinLetters }},
	{"maxWords", "max_words", DefaultMaxWords, 1, MaxMaxWords, noRangeReference,
		func(setting *QuerySuggestionsSetting) *model.Optional[int64] { return &setting.MaxWords }},
	{"maxDigits", "max_digits", DefaultMaxDigits, 0, 0, maxLengthRange,
		func(setting *QuerySuggestionsSetting) *model.Optional[int64] { return &setting.MaxDigits }},
	{"maxMergePhrases", "max_merge_phrases", DefaultMaxMergePhrases, 1, MaxMaxMergePhrases, noRangeReference,
		func(setting *QuerySuggestionsSetting) *model.Optional[int64] { return &setting.MaxMergePhrases }},
	{"mergeMemoryBytes", "merge_memory_bytes", DefaultMergeMemoryBytes, MinMergeMemoryBytes, MaxMergeMemoryBytes, noRangeReference,
		func(setting *QuerySuggestionsSetting) *model.Optional[int64] { return &setting.MergeMemoryBytes }},
	{"saveIntervalMs", "save_interval_ms", DefaultSaveIntervalMS, MinSaveIntervalMS, MaxSaveIntervalMS, noRangeReference,
		func(setting *QuerySuggestionsSetting) *model.Optional[int64] { return &setting.SaveIntervalMS }},
	{"resultChecksPerSecond", "result_checks_per_second", DefaultResultChecksPerSecond, 1, MaxResultChecksPerSecond, noRangeReference,
		func(setting *QuerySuggestionsSetting) *model.Optional[int64] { return &setting.ResultChecksPerSecond }},
}

func settingKeysOf(keyCase Case) map[string]bool {
	keys := map[string]bool{"enabled": true, "fields": true, "schedule": true, keyCase.Key("time_zone", "timeZone"): true}
	for _, entry := range settingRanges {
		keys[keyCase.Key(entry.snake, entry.camel)] = true
	}
	return keys
}

func readSettingFields(value any) ([]string, error) {
	list, ok := value.([]any)
	if !ok || len(list) == 0 || len(list) > MaxSuggestionFields {
		return nil, Invalid("The query suggestions setting needs from 1 to "+strconv.Itoa(MaxSuggestionFields)+" fields", nil)
	}
	seen := make(map[string]bool, len(list))
	fields := make([]string, 0, len(list))
	for _, element := range list {
		field, isText := element.(string)
		if !isText || field == "" || seen[field] {
			return nil, Invalid("Each field of the query suggestions setting must be a distinct, non-empty path", nil)
		}
		seen[field] = true
		fields = append(fields, field)
	}
	return fields, nil
}

func resolvedValues(setting *QuerySuggestionsSetting) []int64 {
	resolved := make([]int64, len(settingRanges))
	for index, entry := range settingRanges {
		resolved[index] = entry.slot(setting).Or(entry.fallback)
	}
	return resolved
}

func requireSettingRanges(setting *QuerySuggestionsSetting) error {
	resolved := resolvedValues(setting)
	for index, entry := range settingRanges {
		maximum := entry.maximum
		if entry.maxOf != noRangeReference {
			maximum = resolved[entry.maxOf]
		}
		if resolved[index] < entry.minimum || resolved[index] > maximum {
			return Invalid(entry.camel+" must be from "+strconv.FormatInt(entry.minimum, 10)+" to "+
				strconv.FormatInt(maximum, 10), map[string]any{"key": entry.camel, "value": resolved[index]})
		}
	}
	people, phrasesPerDay, phrasesPerPerson := resolved[0], resolved[3], resolved[4]
	peoplePerDay, mergePhrases := resolved[5], resolved[11]
	if peoplePerDay*phrasesPerPerson > MaxPersonPairsPerDay {
		return Invalid("maxPeoplePerDay times maxPhrasesPerPerson must stay at or below "+strconv.Itoa(MaxPersonPairsPerDay), nil)
	}
	if phrasesPerDay*people > MaxFilePeoplePerDay {
		return Invalid("maxPhrasesPerDay times minPeople must stay at or below "+strconv.Itoa(MaxFilePeoplePerDay), nil)
	}
	if mergePhrases*people > MaxMergePeople {
		return Invalid("maxMergePhrases times minPeople must stay at or below "+strconv.Itoa(MaxMergePeople), nil)
	}
	return nil
}

func ReadQuerySuggestionsSetting(value any, keyCase Case) (QuerySuggestionsSetting, error) {
	record, ok := AsMap(value)
	if !ok {
		return QuerySuggestionsSetting{}, Invalid("The query suggestions setting must be an object", nil)
	}
	known := settingKeysOf(keyCase)
	for key := range record {
		if !known[key] {
			return QuerySuggestionsSetting{}, Invalid("The query suggestions setting holds an unknown key \""+key+"\"",
				map[string]any{"key": key})
		}
	}
	enabled, isFlag := record["enabled"].(bool)
	if !isFlag {
		return QuerySuggestionsSetting{}, Invalid("The query suggestions setting needs a boolean \"enabled\"", nil)
	}
	fields, err := readSettingFields(record["fields"])
	if err != nil {
		return QuerySuggestionsSetting{}, err
	}
	setting := QuerySuggestionsSetting{Enabled: enabled, Fields: fields}
	for _, entry := range settingRanges {
		raw, has := record[keyCase.Key(entry.snake, entry.camel)]
		if !has {
			continue
		}
		number, whole := AsSafeInteger(raw)
		if !whole {
			return QuerySuggestionsSetting{}, Invalid(entry.camel+" must be a whole number", map[string]any{"key": entry.camel})
		}
		*entry.slot(&setting) = model.Some(number)
	}
	if err := requireSettingRanges(&setting); err != nil {
		return QuerySuggestionsSetting{}, err
	}
	if err := readScheduleAndZone(record, keyCase, &setting); err != nil {
		return QuerySuggestionsSetting{}, err
	}
	encoded, err := codec.Marshal(setting.Value(Snake), codec.EncodeOptions{})
	if err != nil || len(encoded) > MaxSettingBytes {
		return QuerySuggestionsSetting{}, Invalid("The query suggestions setting must encode to at most "+
			strconv.Itoa(MaxSettingBytes)+" bytes", nil)
	}
	return setting, nil
}

func readScheduleAndZone(record map[string]any, keyCase Case, setting *QuerySuggestionsSetting) error {
	if raw, has := record["schedule"]; has {
		schedule, isText := raw.(string)
		if !isText {
			return Invalid("schedule must be a string", nil)
		}
		if schedule != ScheduleOff && !IsSchedule(schedule) {
			return Invalid("schedule must be \"off\" or a cron expression of five fields", map[string]any{"schedule": schedule})
		}
		setting.Schedule = model.Some(schedule)
	}
	if raw, has := record[keyCase.Key("time_zone", "timeZone")]; has {
		zone, isText := raw.(string)
		if !isText || !IsTimeZone(zone) {
			return Invalid("timeZone must name an IANA time zone", map[string]any{"timeZone": zone})
		}
		setting.TimeZone = model.Some(zone)
	}
	return nil
}

func (setting QuerySuggestionsSetting) Value(keyCase Case) codec.OrderedMap {
	entries := codec.OrderedMap{{Key: "enabled", Value: setting.Enabled}, {Key: "fields", Value: Texts(setting.Fields)}}
	copied := setting
	for _, entry := range settingRanges {
		PutOptional(&entries, keyCase.Key(entry.snake, entry.camel), *entry.slot(&copied), Number[int64])
	}
	PutOptional(&entries, "schedule", setting.Schedule, Text)
	PutOptional(&entries, keyCase.Key("time_zone", "timeZone"), setting.TimeZone, Text)
	return entries
}

type QuerySuggestionsSource struct {
	Index string
	Group string
}

func ReadQuerySuggestionsSource(value any) (QuerySuggestionsSource, error) {
	record, ok := AsMap(value)
	if !ok {
		return QuerySuggestionsSource{}, Invalid("The suggestions index marker must be a map", nil)
	}
	for key := range record {
		if key != "index" && key != "group" {
			return QuerySuggestionsSource{}, Invalid("The suggestions index marker holds an unknown key", nil)
		}
	}
	index, isText := record["index"].(string)
	if !isText || index == "" || text.UTF16Length(index) > MaxSourceIndexNameLength {
		return QuerySuggestionsSource{}, Invalid("The suggestions index marker needs the name of its source index", nil)
	}
	group, isGroupText := record["group"].(string)
	if !isGroupText || !IsGroup(group) {
		return QuerySuggestionsSource{}, Invalid("The suggestions index marker needs a valid group", nil)
	}
	return QuerySuggestionsSource{Index: index, Group: group}, nil
}

func (source QuerySuggestionsSource) Value() codec.OrderedMap {
	return codec.OrderedMap{{Key: "index", Value: source.Index}, {Key: "group", Value: source.Group}}
}

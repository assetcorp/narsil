package suggestions

type DayLimits struct {
	MinPeople           int
	MaxPhrasesPerDay    int
	MaxPhrasesPerPerson int
	MaxPeoplePerDay     int
	MaxGroups           int
}

type CountOutcome string

const (
	CountRecorded    CountOutcome = "recorded"
	CountRepeat      CountOutcome = "repeat"
	CountPersonLimit CountOutcome = "person-limit"
	CountPhraseLimit CountOutcome = "phrase-limit"
	CountPeopleLimit CountOutcome = "people-limit"
	CountGroupLimit  CountOutcome = "group-limit"
)

type dayPhrase struct {
	text   string
	count  uint32
	people []ScrambledID
}

type dayGroup struct {
	name    string
	numbers []int
	byText  map[string]int
}

type DayCounts struct {
	Day     string
	Limits  DayLimits
	groups  []*dayGroup
	byGroup map[string]*dayGroup
	phrases []dayPhrase
	people  map[ScrambledID]int
	pairs   [][]uint16
	changed bool
}

func NewDayCounts(day string, limits DayLimits) *DayCounts {
	return &DayCounts{Day: day, Limits: limits, byGroup: map[string]*dayGroup{}, people: map[ScrambledID]int{}}
}

func (counts *DayCounts) IsChanged() bool { return counts.changed }

func (counts *DayCounts) MarkSaved() { counts.changed = false }

func (counts *DayCounts) MarkChanged() { counts.changed = true }

func (counts *DayCounts) HasGroup(group string) bool {
	_, found := counts.byGroup[group]
	return found
}

func (counts *DayCounts) GroupNames() []string {
	names := make([]string, 0, len(counts.groups))
	for _, group := range counts.groups {
		names = append(names, group.name)
	}
	return names
}

func (counts *DayCounts) personHasPhrase(person int, number int) bool {
	for _, held := range counts.pairs[person] {
		if int(held) == number {
			return true
		}
	}
	return false
}

func (counts *DayCounts) Count(group, text string, id ScrambledID, groupAllowed bool) CountOutcome {
	table, groupFound := counts.byGroup[group]
	existing, phraseFound := -1, false
	if groupFound {
		existing, phraseFound = table.byText[text]
	}
	person, personFound := counts.people[id]
	if personFound && phraseFound && counts.personHasPhrase(person, existing) {
		return CountRepeat
	}
	if personFound && len(counts.pairs[person]) >= counts.Limits.MaxPhrasesPerPerson {
		return CountPersonLimit
	}
	if !phraseFound && len(counts.phrases) >= counts.Limits.MaxPhrasesPerDay {
		return CountPhraseLimit
	}
	if !personFound && len(counts.people) >= counts.Limits.MaxPeoplePerDay {
		return CountPeopleLimit
	}
	if !groupFound && (!groupAllowed || len(counts.groups) >= counts.Limits.MaxGroups) {
		return CountGroupLimit
	}
	number := existing
	if !phraseFound {
		number = counts.addPhrase(group, text)
	}
	if !personFound {
		person = len(counts.pairs)
		counts.people[id] = person
		counts.pairs = append(counts.pairs, nil)
	}
	counts.pairs[person] = append(counts.pairs[person], uint16(number))
	counts.phrases[number].count++
	counts.addToPeople(number, id)
	counts.changed = true
	return CountRecorded
}

func (counts *DayCounts) RestorePhrase(group, text string, count uint64, people [][]byte) bool {
	if table, found := counts.byGroup[group]; found {
		if _, held := table.byText[text]; held {
			return false
		}
	} else if len(counts.groups) >= counts.Limits.MaxGroups {
		return false
	}
	if len(counts.phrases) >= counts.Limits.MaxPhrasesPerDay {
		return false
	}
	number := counts.addPhrase(group, text)
	for _, raw := range people {
		var id ScrambledID
		copy(id[:], raw)
		counts.addToPeople(number, id)
	}
	stored := count
	if held := uint64(len(counts.phrases[number].people)); held > stored {
		stored = held
	}
	counts.phrases[number].count = uint32(stored)
	return true
}

func (counts *DayCounts) addPhrase(group, text string) int {
	table, found := counts.byGroup[group]
	if !found {
		table = &dayGroup{name: group, byText: map[string]int{}}
		counts.byGroup[group] = table
		counts.groups = append(counts.groups, table)
	}
	number := len(counts.phrases)
	counts.phrases = append(counts.phrases, dayPhrase{text: text})
	table.byText[text] = number
	table.numbers = append(table.numbers, number)
	return number
}

func (counts *DayCounts) addToPeople(number int, id ScrambledID) {
	held := &counts.phrases[number]
	if len(held.people) >= counts.Limits.MinPeople {
		return
	}
	for _, existing := range held.people {
		if existing == id {
			return
		}
	}
	held.people = append(held.people, id)
}

func (counts *DayCounts) writeGroups(out *writer) {
	out.mapHeader(len(counts.groups))
	for _, group := range counts.groups {
		out.text(group.name)
		out.arrayHeader(len(group.numbers))
		for _, number := range group.numbers {
			held := counts.phrases[number]
			out.mapHeader(phraseKeys)
			out.text(keyPhrase)
			out.text(held.text)
			out.text(keyCount)
			out.uint(uint64(held.count))
			out.text(keyPeople)
			out.arrayHeader(len(held.people))
			for _, id := range held.people {
				out.binary(id[:])
			}
		}
	}
}

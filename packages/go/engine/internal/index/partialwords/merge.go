package partialwords

type MergeSource struct {
	Table   *FrozenTable
	TokenAt func(index int) string
	Merged  []int32
	Texts   DocumentTexts
}

func keptOrdinals(merged []int32) int {
	kept := 0
	for _, target := range merged {
		if target >= 0 {
			kept++
		}
	}
	return kept
}

func correctionsAgainst(table *FrozenTable, merged []int32) int {
	corrections := 0
	for ordinal, target := range merged {
		if (target >= 0) != table.counted(ordinal) {
			corrections++
		}
	}
	return corrections
}

func (a *Analysis) CountKeptSpellings(counts *SpellingCounts, source MergeSource) error {
	table := source.Table
	if table == nil || !SameFields(table.Fields, a.Fields) || correctionsAgainst(table, source.Merged) > keptOrdinals(source.Merged) {
		for ordinal, target := range source.Merged {
			if target < 0 {
				continue
			}
			if err := a.countOrdinal(counts, source.Texts, ordinal); err != nil {
				return err
			}
		}
		return nil
	}
	corrected := NewSpellingCounts()
	table.CountSpellings(corrected, source.TokenAt)
	removed := NewRemovedSpellings()
	var returned []int
	for ordinal, target := range source.Merged {
		kept := target >= 0
		if kept == table.counted(ordinal) {
			continue
		}
		if kept {
			returned = append(returned, ordinal)
			continue
		}
		documentTexts, err := source.Texts(ordinal)
		if err != nil {
			return err
		}
		if err := a.addRemovedSpellings(removed, documentTexts); err != nil {
			return err
		}
	}
	if err := a.subtractRemovedSpellings(corrected, removed); err != nil {
		return err
	}
	for _, ordinal := range returned {
		if err := a.countOrdinal(corrected, source.Texts, ordinal); err != nil {
			return err
		}
	}
	counts.Add(corrected)
	return nil
}

func (a *Analysis) subtractRemovedSpellings(counts *SpellingCounts, removed *RemovedSpellings) error {
	tokenOf := make(map[string]string, counts.Len())
	for token, bySpelling := range counts.byToken {
		for spelling := range bySpelling {
			tokenOf[spelling] = token
		}
	}
	for _, spelling := range removed.order {
		stored := spelling
		if _, held := tokenOf[spelling]; !held {
			fallback, found, err := removed.fallbackOf(spelling, a)
			if err != nil {
				return err
			}
			if found {
				stored = fallback
			}
		}
		if token, held := tokenOf[stored]; held {
			counts.Count(token, stored, -removed.counts[spelling])
		}
	}
	return nil
}

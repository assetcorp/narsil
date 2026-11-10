package growing

import (
	"cmp"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type runMember struct {
	points   [runPoints]uint32
	spelling uint32
}

func codePoints(text []uint16, visit func(uint32)) {
	for at := 0; at < len(text); at++ {
		unit := uint32(text[at])
		if unit >= 0xd800 && unit < 0xdc00 && at+1 < len(text) {
			low := uint32(text[at+1])
			if low >= 0xdc00 && low < 0xe000 {
				visit(0x10000 + (unit-0xd800)<<10 + (low - 0xdc00))
				at++
				continue
			}
		}
		visit(unit)
	}
}

func pointCount(text []uint16) uint32 {
	var count uint32
	codePoints(text, func(uint32) { count++ })
	return count
}

func spellingRefusal(reason string) error {
	return narsilerr.New(narsilerr.CodePartitionCorrupted, reason, nil)
}

func (t *spellingTable) reserveWords(words [][]uint16) error {
	count := t.strings.count()
	units := t.strings.unitsUsed()
	added := uint64(0)
	var members []runMember
	for _, word := range words {
		points := pointCount(word)
		if points <= spellingMinPoints {
			continue
		}
		ordinal, found := t.strings.find(word)
		if !found {
			ordinal = count + added
			if ordinal >= maxStringOrdinal || uint64(len(word)) > maxStringUnits-(units-t.strings.unitsUsed()) {
				return spellingRefusal("the spelling table has no room for another spelling")
			}
			added++
			units += uint64(len(word))
			members = appendRuns(members, word, uint32(ordinal))
		}
	}
	if err := t.reserve(count+added, units, &t.codePoints); err != nil {
		return err
	}
	if len(members) == 0 {
		return nil
	}
	members = sortedRuns(members)
	runCount := uint64(t.runs.header[headerCount]) + uint64(len(members))
	if err := t.runs.reserve(runCount, t.runs.members.len()); err != nil {
		return err
	}
	needed, err := t.runs.plannedMemberEnd(members)
	if err != nil {
		return err
	}
	capacity := t.runs.members.len()
	for capacity < needed {
		grown, err := grownCapacity(capacity, capacity+1)
		if err != nil {
			return err
		}
		capacity = grown
	}
	return t.runs.reserve(runCount, capacity)
}

func appendRuns(members []runMember, text []uint16, spelling uint32) []runMember {
	var first, second uint32
	seen := 0
	codePoints(text, func(point uint32) {
		seen++
		if seen >= runPoints {
			members = append(members, runMember{points: [runPoints]uint32{first, second, point}, spelling: spelling})
		}
		first, second = second, point
	})
	return members
}

func compareRuns(left, right runMember) int {
	for at := range runPoints {
		if left.points[at] != right.points[at] {
			return cmp.Compare(left.points[at], right.points[at])
		}
	}
	return 0
}

func sortedRuns(members []runMember) []runMember {
	slices.SortFunc(members, func(left, right runMember) int {
		if order := compareRuns(left, right); order != 0 {
			return order
		}
		return cmp.Compare(left.spelling, right.spelling)
	})
	return slices.Compact(members)
}

type memberPlan struct {
	heads []uint32
	end   uint64
	free  uint64
}

func (t *runTable) plannedMemberEnd(members []runMember) (uint64, error) {
	plan := memberPlan{heads: slices.Clone(t.freeHeads), end: uint64(t.allocation[allocationEnd]), free: uint64(t.allocation[allocationFree])}
	placed := map[uint64]struct{}{}
	added := uint64(0)
	for first := 0; first < len(members); {
		end := first + 1
		for end < len(members) && compareRuns(members[first], members[end]) == 0 {
			end++
		}
		ordinal, isNew, err := t.locate(members[first].points[:], placed, &added)
		if err != nil {
			return 0, err
		}
		sourceLength, oldLength := uint64(0), uint64(0)
		if !isNew {
			sourceLength, oldLength, err = t.previousSlice(ordinal)
			if err != nil {
				return 0, err
			}
		}
		length := oldLength + uint64(end-first)
		if length > maxPoolEntries {
			return 0, spellingRefusal("a run list of the spelling table exceeds its uint32 length")
		}
		if length > sourceLength {
			if err := t.allocateMembers(&plan, length); err != nil {
				return 0, err
			}
		}
		first = end
	}
	return plan.end, nil
}

func (t *runTable) locate(points []uint32, placed map[uint64]struct{}, added *uint64) (uint64, bool, error) {
	slots := t.slots.values
	mask := uint64(len(slots) - 1)
	count := uint64(t.header[headerCount])
	slot := uint64(hashRun(points)) & mask
	available := int64(-1)
	for scanned := 0; scanned < len(slots); scanned++ {
		if _, taken := placed[slot]; !taken {
			entry := slots[slot]
			if entry > 0 && uint64(entry) <= count && uint64(entry)*runPoints <= t.runs.len() && slices.Equal(t.runs.values[(uint64(entry)-1)*runPoints:uint64(entry)*runPoints], points) {
				return uint64(entry) - 1, false, nil
			}
			if entry <= 0 {
				if available < 0 {
					available = int64(slot)
				} else if entry == 0 {
					ordinal := count + *added
					if ordinal >= t.listStart.len() || ordinal >= lastRunCount {
						return 0, false, spellingRefusal("the spelling run table has no room for another run")
					}
					placed[uint64(available)] = struct{}{}
					*added++
					return ordinal, true, nil
				}
			}
		}
		slot = (slot + 1) & mask
	}
	return 0, false, spellingRefusal("the spelling run table has no free slot for another run")
}

func (t *runTable) previousSlice(ordinal uint64) (uint64, uint64, error) {
	class := t.listClass.values[ordinal]
	start := uint64(t.listStart.values[ordinal])
	allocated := uint64(t.allocation[allocationEnd])
	if int(class) >= len(sliceCapacities) || start > allocated {
		return 0, 0, spellingRefusal("a run list of the spelling table points outside its members")
	}
	capacity := uint64(sliceCapacities[class])
	length := uint64(t.listLength.values[ordinal])
	if capacity > allocated-start || length > capacity {
		return 0, 0, spellingRefusal("a run list of the spelling table points outside its members")
	}
	return capacity, length, nil
}

func (t *runTable) allocateMembers(plan *memberPlan, length uint64) error {
	low, high := 0, len(sliceCapacities)
	if uint64(sliceCapacities[0]) < length {
		for low < high {
			middle := low + (high-low)/2
			if uint64(sliceCapacities[middle]) < length {
				low = middle + 1
			} else {
				high = middle
			}
		}
	}
	if low >= len(sliceCapacities) || length == 0 {
		return spellingRefusal("a run list of the spelling table needs a slice larger than any class")
	}
	size := uint64(sliceCapacities[low])
	start := uint64(plan.heads[low])
	if start == noFreeSlice {
		plan.end += size
		return nil
	}
	allocated := uint64(t.allocation[allocationEnd])
	if start >= allocated || size > allocated-start || size > plan.free || start >= t.members.len() {
		return spellingRefusal("a free run list of the spelling table points outside its members")
	}
	plan.heads[low] = t.members.values[start]
	plan.free -= size
	return nil
}

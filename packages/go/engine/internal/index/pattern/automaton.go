package pattern

const (
	beforeValueStart = 0
	afterValueEnd    = 0
	wordCodePoint    = 1
	otherCodePoint   = 2
	edgeKinds        = 3

	startMask     uint16 = 0b000_000_111
	endMask       uint16 = 0b001_001_001
	wordEdgeMask  uint16 = 0b010_101_010
	anyContextMsk uint16 = 0b111_111_111

	consumeState uint8 = 0
	splitState   uint8 = 1
	assertState  uint8 = 2
	matchState   uint8 = 3

	anyCodePoint    int32 = -2
	testedCodePoint int32 = -1

	matchReached = -1
	unsetState   = -1
	lastStamp    = 0xFFFFFFFF
)

var wordKindEdges = [...]uint32{0x30, 0x3a, 0x41, 0x5b, 0x5f, 0x60, 0x61, 0x7b}

type codePointTest struct {
	bytes   int
	ranges  []uint32
	negated bool
	folded  bool
}

func (test *codePointTest) has(codePoint rune) bool {
	if !test.folded {
		return inRanges(test.ranges, codePoint) != test.negated
	}
	return holdsFold(test.ranges, codePoint) != test.negated
}

func holdsFold(ranges []uint32, folded rune) bool {
	if inRanges(ranges, folded) {
		return true
	}
	for _, source := range singleFoldSources(folded) {
		if inRanges(ranges, source) {
			return true
		}
	}
	return false
}

func inRanges(ranges []uint32, codePoint rune) bool {
	if codePoint < 0 {
		return false
	}
	value := uint32(codePoint)
	low, high := 0, len(ranges)/2
	for low < high {
		middle := int(uint(low+high) >> 1)
		switch {
		case value < ranges[middle*2]:
			high = middle
		case value > ranges[middle*2+1]:
			low = middle + 1
		default:
			return true
		}
	}
	return false
}

type codePointClasses struct {
	starts      []uint32
	foldTargets bool
	direct      [directClassCodePoints]int32
}

func searchedClass(starts []uint32, foldTargets bool, codePoint rune) int32 {
	if foldTargets && isFoldTarget(codePoint) {
		return -1 - codePoint
	}
	value := uint32(max(codePoint, 0))
	low, high := 0, len(starts)
	for low < high {
		middle := int(uint(low+high) >> 1)
		if starts[middle] <= value {
			low = middle + 1
		} else {
			high = middle
		}
	}
	return int32(low)
}

func newCodePointClasses(starts []uint32, foldTargets bool) codePointClasses {
	classes := codePointClasses{starts: starts, foldTargets: foldTargets}
	for codePoint := range classes.direct {
		classes.direct[codePoint] = searchedClass(starts, foldTargets, rune(codePoint))
	}
	return classes
}

func (classes *codePointClasses) directBytes() int {
	return len(classes.direct) * uint32Bytes
}

type program struct {
	positions     int
	states        int
	kinds         []uint8
	next          []int32
	alternative   []int32
	masks         []uint16
	literals      []int32
	tests         []*codePointTest
	start         int32
	anchoredStart bool
	classes       codePointClasses
	bytes         int
}

func (p *program) classOf(codePoint rune) int32 {
	if codePoint >= 0 && codePoint < directClassCodePoints {
		return p.classes.direct[codePoint]
	}
	return searchedClass(p.classes.starts, p.classes.foldTargets, codePoint)
}

func isWordCodePoint(codePoint rune) bool {
	return (codePoint >= 0x30 && codePoint <= 0x39) || (codePoint >= 0x41 && codePoint <= 0x5a) ||
		(codePoint >= 0x61 && codePoint <= 0x7a) || codePoint == 0x5f
}

func kindOf(codePoint rune) int {
	if isWordCodePoint(codePoint) {
		return wordCodePoint
	}
	return otherCodePoint
}

func contextOf(previous, following int) int {
	return previous*edgeKinds + following
}

func (p *program) accepts(position uint32, codePoint rune) bool {
	literal := p.literals[position]
	if literal >= 0 {
		return literal == codePoint
	}
	if literal == anyCodePoint {
		return true
	}
	test := p.tests[position]
	return test != nil && test.has(codePoint)
}

type closureScratch struct {
	marks []uint32
	stack []int32
	stamp uint32
}

func newClosureScratch(states int) *closureScratch {
	return &closureScratch{marks: make([]uint32, states), stack: make([]int32, states)}
}

func (scratch *closureScratch) nextStamp() uint32 {
	if scratch.stamp == lastStamp {
		clear(scratch.marks)
		scratch.stamp = 0
	}
	scratch.stamp++
	return scratch.stamp
}

func (p *program) closeOver(seeds []uint32, fromStart bool, context int, scratch *closureScratch, out []uint32) int {
	marks, stack := scratch.marks, scratch.stack
	stamp := scratch.nextStamp()
	depth := 0
	for _, seed := range seeds {
		state := p.next[seed]
		if marks[state] != stamp {
			marks[state] = stamp
			stack[depth] = state
			depth++
		}
	}
	if fromStart && marks[p.start] != stamp {
		marks[p.start] = stamp
		stack[depth] = p.start
		depth++
	}
	count := 0
	for depth > 0 {
		depth--
		state := stack[depth]
		kind := p.kinds[state]
		if kind == consumeState {
			out[count] = uint32(state)
			count++
			continue
		}
		if kind == matchState {
			return matchReached
		}
		if kind == assertState && (p.masks[state]>>uint(context))&1 == 0 {
			continue
		}
		following := p.next[state]
		if marks[following] != stamp {
			marks[following] = stamp
			stack[depth] = following
			depth++
		}
		if kind != splitState {
			continue
		}
		other := p.alternative[state]
		if marks[other] != stamp {
			marks[other] = stamp
			stack[depth] = other
			depth++
		}
	}
	return count
}

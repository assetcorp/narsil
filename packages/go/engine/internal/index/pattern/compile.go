package pattern

import "slices"

type programBuilder struct {
	kinds       []uint8
	next        []int32
	alternative []int32
	masks       []uint16
	literals    []int32
	tests       []*codePointTest
	positions   int
}

func (builder *programBuilder) add(kind uint8, next, alternative int32, mask uint16) int32 {
	builder.kinds = append(builder.kinds, kind)
	builder.next = append(builder.next, next)
	builder.alternative = append(builder.alternative, alternative)
	builder.masks = append(builder.masks, mask)
	builder.literals = append(builder.literals, unsetState)
	builder.tests = append(builder.tests, nil)
	return int32(len(builder.kinds) - 1)
}

func (builder *programBuilder) consume(literal int32, test *codePointTest, next int32) int32 {
	state := builder.add(consumeState, next, unsetState, 0)
	builder.literals[state] = literal
	builder.tests[state] = test
	builder.positions++
	return state
}

func (builder *programBuilder) split(first, second int32) int32 {
	return builder.add(splitState, first, second, 0)
}

func (builder *programBuilder) compile(step *plan, next int32) int32 {
	switch step.kind {
	case planConsume:
		return builder.consume(step.literal, step.test, next)
	case planAssert:
		if step.mask == anyContextMsk {
			return next
		}
		return builder.add(assertState, next, unsetState, step.mask)
	case planSequence:
		entry := next
		for at := len(step.children) - 1; at >= 0; at-- {
			entry = builder.compile(step.children[at], entry)
		}
		return entry
	case planChoice:
		entry := builder.compile(step.children[len(step.children)-1], next)
		for at := len(step.children) - 2; at >= 0; at-- {
			entry = builder.split(builder.compile(step.children[at], next), entry)
		}
		return entry
	}
	return builder.compileRepeat(step.body, step.min, step.max, next)
}

func (builder *programBuilder) loop(body *plan, next int32, entersBody bool) int32 {
	loop := builder.split(unsetState, next)
	entry := builder.compile(body, loop)
	builder.next[loop] = entry
	if entersBody {
		return entry
	}
	return loop
}

func (builder *programBuilder) compileRepeat(body *plan, low, high int, next int32) int32 {
	var entry int32
	required := low
	if high == unboundedRepeat {
		entry = builder.loop(body, next, low > 0)
		if low > 0 {
			required--
		}
	} else {
		entry = next
		for optional := high - low; optional > 0; optional-- {
			entry = builder.split(builder.compile(body, entry), next)
		}
	}
	for ; required > 0; required-- {
		entry = builder.compile(body, entry)
	}
	return entry
}

func startsOnlyAtStart(compiled *program) bool {
	scratch := newClosureScratch(compiled.states)
	candidates := make([]uint32, compiled.positions)
	for _, previous := range [...]int{wordCodePoint, otherCodePoint} {
		for _, following := range [...]int{afterValueEnd, wordCodePoint, otherCodePoint} {
			reached := compiled.closeOver(nil, true, contextOf(previous, following), scratch, candidates)
			if reached == matchReached || reached > 0 {
				return false
			}
		}
	}
	return true
}

type classEdges struct {
	edges       map[uint32]struct{}
	tests       map[*codePointTest]struct{}
	foldTargets bool
}

func (collected *classEdges) collect(step *plan) {
	switch step.kind {
	case planConsume:
		if step.literal >= 0 {
			collected.edges[uint32(step.literal)] = struct{}{}
			collected.edges[uint32(step.literal)+1] = struct{}{}
			return
		}
		if step.test == nil {
			return
		}
		if _, held := collected.tests[step.test]; held {
			return
		}
		collected.tests[step.test] = struct{}{}
		collected.foldTargets = collected.foldTargets || step.test.folded
		for at := 0; at+1 < len(step.test.ranges); at += 2 {
			collected.edges[step.test.ranges[at]] = struct{}{}
			collected.edges[step.test.ranges[at+1]+1] = struct{}{}
		}
	case planSequence, planChoice:
		for _, child := range step.children {
			collected.collect(child)
		}
	case planRepeat:
		collected.collect(step.body)
	}
}

func planClasses(step *plan) codePointClasses {
	collected := &classEdges{edges: map[uint32]struct{}{}, tests: map[*codePointTest]struct{}{}}
	for _, edge := range wordKindEdges {
		collected.edges[edge] = struct{}{}
	}
	collected.collect(step)
	starts := make([]uint32, 0, len(collected.edges))
	for edge := range collected.edges {
		starts = append(starts, edge)
	}
	slices.Sort(starts)
	return newCodePointClasses(starts, collected.foldTargets)
}

func programBytes(states, positions int, tests map[*codePointTest]struct{}, classes *codePointClasses) int {
	bytes := states*programStateBytes + positions*programPositionBytes + len(classes.starts)*uint32Bytes + classes.directBytes()
	for test := range tests {
		bytes += test.bytes
	}
	return bytes
}

type planSizes struct {
	states    int
	positions int
}

func sizeOf(step *plan, tests map[*codePointTest]struct{}) planSizes {
	switch step.kind {
	case planConsume:
		if step.test != nil {
			tests[step.test] = struct{}{}
		}
		return planSizes{1, 1}
	case planAssert:
		if step.mask == anyContextMsk {
			return planSizes{}
		}
		return planSizes{states: 1}
	case planSequence, planChoice:
		total := planSizes{}
		if step.kind == planChoice {
			total.states = len(step.children) - 1
		}
		for _, child := range step.children {
			size := sizeOf(child, tests)
			total.states += size.states
			total.positions += size.positions
		}
		return total
	}
	body := sizeOf(step.body, tests)
	if step.max == unboundedRepeat {
		copies := max(step.min, 1)
		return planSizes{states: 1 + copies*body.states, positions: copies * body.positions}
	}
	return planSizes{states: step.max - step.min + step.max*body.states, positions: step.max * body.positions}
}

type programSize struct {
	states    int
	positions int
	bytes     int
}

func planSize(step *plan) programSize {
	tests := map[*codePointTest]struct{}{}
	size := sizeOf(step, tests)
	states := size.states + 1
	classes := planClasses(step)
	return programSize{states: states, positions: size.positions, bytes: programBytes(states, size.positions, tests, &classes)}
}

func compileProgram(step *plan) *program {
	builder := &programBuilder{}
	match := builder.add(matchState, unsetState, unsetState, 0)
	start := builder.compile(step, match)
	count := len(builder.kinds)
	renumbered := make([]int32, count)
	nextPosition, nextOther := int32(0), int32(builder.positions)
	for state := range count {
		if builder.kinds[state] == consumeState {
			renumbered[state] = nextPosition
			nextPosition++
		} else {
			renumbered[state] = nextOther
			nextOther++
		}
	}
	compiled := &program{
		positions:   builder.positions,
		states:      count,
		kinds:       make([]uint8, count),
		next:        make([]int32, count),
		alternative: make([]int32, count),
		masks:       make([]uint16, count),
		literals:    make([]int32, builder.positions),
		tests:       make([]*codePointTest, builder.positions),
	}
	renumber := func(state int32) int32 {
		if state == unsetState {
			return unsetState
		}
		return renumbered[state]
	}
	tests := map[*codePointTest]struct{}{}
	for state := range count {
		target := renumbered[state]
		compiled.kinds[target] = builder.kinds[state]
		compiled.next[target] = renumber(builder.next[state])
		compiled.alternative[target] = renumber(builder.alternative[state])
		compiled.masks[target] = builder.masks[state]
		if int(target) < builder.positions {
			compiled.literals[target] = builder.literals[state]
			compiled.tests[target] = builder.tests[state]
			if builder.tests[state] != nil {
				tests[builder.tests[state]] = struct{}{}
			}
		}
	}
	compiled.start = renumbered[start]
	compiled.classes = planClasses(step)
	compiled.bytes = programBytes(count, builder.positions, tests, &compiled.classes)
	compiled.anchoredStart = startsOnlyAtStart(compiled)
	return compiled
}

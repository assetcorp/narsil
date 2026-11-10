package pattern

type planKind uint8

const (
	planConsume planKind = iota
	planAssert
	planSequence
	planChoice
	planRepeat
)

type plan struct {
	kind     planKind
	literal  int32
	test     *codePointTest
	mask     uint16
	children []*plan
	body     *plan
	min      int
	max      int
}

func emptyPlan() *plan {
	return &plan{kind: planAssert, mask: anyContextMsk}
}

func literalPlan(codePoint int32) *plan {
	return &plan{kind: planConsume, literal: codePoint}
}

func testedPlan(test *codePointTest) *plan {
	return &plan{kind: planConsume, literal: testedCodePoint, test: test}
}

type sequenceBuilder struct {
	kept []*plan
	mask uint16
}

func (builder *sequenceBuilder) flushMask() {
	if builder.mask != anyContextMsk {
		builder.kept = append(builder.kept, &plan{kind: planAssert, mask: builder.mask})
	}
	builder.mask = anyContextMsk
}

func (builder *sequenceBuilder) visit(item *plan) {
	switch item.kind {
	case planSequence:
		for _, nested := range item.children {
			builder.visit(nested)
		}
	case planAssert:
		builder.mask &= item.mask
	default:
		builder.flushMask()
		builder.kept = append(builder.kept, item)
	}
}

func sequenceOf(items []*plan) *plan {
	builder := &sequenceBuilder{mask: anyContextMsk}
	for _, item := range items {
		builder.visit(item)
	}
	if len(builder.kept) == 0 {
		return &plan{kind: planAssert, mask: builder.mask}
	}
	builder.flushMask()
	if len(builder.kept) == 1 {
		return builder.kept[0]
	}
	return &plan{kind: planSequence, children: builder.kept}
}

type choiceBuilder struct {
	kept  []*plan
	mask  uint16
	empty bool
}

func (builder *choiceBuilder) visit(branch *plan) {
	switch branch.kind {
	case planChoice:
		for _, nested := range branch.children {
			builder.visit(nested)
		}
	case planAssert:
		builder.mask |= branch.mask
		builder.empty = true
	default:
		builder.kept = append(builder.kept, branch)
	}
}

func choiceOf(branches []*plan) *plan {
	builder := &choiceBuilder{}
	for _, branch := range branches {
		builder.visit(branch)
	}
	if len(builder.kept) == 0 {
		return &plan{kind: planAssert, mask: builder.mask}
	}
	if builder.empty {
		builder.kept = append(builder.kept, &plan{kind: planAssert, mask: builder.mask})
	}
	if len(builder.kept) == 1 {
		return builder.kept[0]
	}
	return &plan{kind: planChoice, children: builder.kept}
}

func isLoose(candidate *plan) bool {
	return candidate.kind == planRepeat && candidate.min <= 1 && (candidate.max == unboundedRepeat || candidate.max == 1)
}

func repeatOf(body *plan, low, high int) *plan {
	if high == 0 {
		return emptyPlan()
	}
	if body.kind == planAssert {
		if low == 0 {
			return emptyPlan()
		}
		return body
	}
	if low == 1 && high == 1 {
		return body
	}
	loose := low <= 1 && (high == unboundedRepeat || high == 1)
	if loose && isLoose(body) {
		collapsed := &plan{kind: planRepeat, body: body.body, min: 1, max: 1}
		if low == 0 || body.min == 0 {
			collapsed.min = 0
		}
		if high == unboundedRepeat || body.max == unboundedRepeat {
			collapsed.max = unboundedRepeat
		}
		return collapsed
	}
	return &plan{kind: planRepeat, body: body, min: low, max: high}
}

func foldedLiteral(codePoint rune, scratch []rune) *plan {
	folded := appendFolded(scratch[:0], codePoint)
	items := make([]*plan, len(folded))
	for at, foldedCodePoint := range folded {
		items[at] = literalPlan(foldedCodePoint)
	}
	return sequenceOf(items)
}

func setPlan(parsed *node, caseFold bool) *plan {
	single := testedPlan(setTest(parsed.setItems, parsed.negated, caseFold))
	if !caseFold || parsed.negated {
		return single
	}
	folds := distinctMultiFolds(parsed.setItems)
	if len(folds) == 0 {
		return single
	}
	branches := []*plan{single}
	for _, fold := range folds {
		items := make([]*plan, len(fold))
		for at, codePoint := range fold {
			items[at] = literalPlan(codePoint)
		}
		branches = append(branches, sequenceOf(items))
	}
	return choiceOf(branches)
}

func lowerNode(parsed *node, caseFold bool, scratch []rune) *plan {
	switch parsed.kind {
	case nodeLiteral:
		if caseFold {
			return foldedLiteral(parsed.codePoint, scratch)
		}
		return literalPlan(parsed.codePoint)
	case nodeAny:
		return literalPlan(anyCodePoint)
	case nodeClass:
		return testedPlan(classTest(parsed.class))
	case nodeSet:
		return setPlan(parsed, caseFold)
	case nodeAssert:
		return &plan{kind: planAssert, mask: parsed.mask}
	case nodeSequence, nodeChoice:
		lowered := make([]*plan, len(parsed.children))
		for at, child := range parsed.children {
			lowered[at] = lowerNode(child, caseFold, scratch)
		}
		if parsed.kind == nodeSequence {
			return sequenceOf(lowered)
		}
		return choiceOf(lowered)
	case nodeRepeat:
		return repeatOf(lowerNode(parsed.body, caseFold, scratch), parsed.min, parsed.max)
	}
	return lowerNode(parsed.body, caseFold, scratch)
}

func lowerPattern(parsed *node, caseFold bool) *plan {
	return lowerNode(parsed, caseFold, make([]rune, 0, 4))
}

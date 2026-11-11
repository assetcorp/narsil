package pattern

import "strconv"

const (
	noCountReason          = `holds a "{" that doesn't open a count such as {2}, {2,}, or {2,5}. Write "\{" to match the brace itself`
	rangeEndsInClassReason = "holds a set range whose high end is a class, while both ends of a set range must be code points"
	setNeverClosesReason   = "opens a set that it never closes"
	negatedEmptySetReason  = `holds the set "[^]", which has no member, because a "^" after "[" always negates the set. Write "\^" to match a caret, "." to match any code point, or "\]" to match "]" inside a set`
	noCodePoint            = rune(-1)
)

func isReserved(codePoint rune) bool {
	switch codePoint {
	case '\\', '.', '|', '*', '+', '?', '{', '}', '(', ')', '[', ']', '^', '$', '<', '>':
		return true
	}
	return false
}

func isClassEscape(codePoint rune) bool {
	return codePoint == 'd' || codePoint == 'w' || codePoint == 's'
}

func isASCIIPunctuation(codePoint rune) bool {
	return (codePoint >= 0x21 && codePoint <= 0x2f) || (codePoint >= 0x3a && codePoint <= 0x40) ||
		(codePoint >= 0x5b && codePoint <= 0x60) || (codePoint >= 0x7b && codePoint <= 0x7e)
}

func isDigit(codePoint rune) bool {
	return codePoint >= '0' && codePoint <= '9'
}

func unknownEscape(codePoint rune) string {
	shown := quoted(`\` + string(codePoint))
	if isDigit(codePoint) {
		return "holds the back-reference " + shown + ", which the grammar leaves out"
	}
	if codePoint == 'p' || codePoint == 'P' {
		return "holds the Unicode property class " + shown + ", which the grammar leaves out"
	}
	return "holds " + shown + `. A "\" can come only before an ASCII punctuation mark, "d", "w", "s", or "b"`
}

func reservedHere(codePoint rune) string {
	shown := string(codePoint)
	if codePoint == '*' || codePoint == '+' || codePoint == '?' {
		return "holds the repeat " + quoted(shown) + " with nothing before it to repeat"
	}
	return "holds " + quoted(shown) + ", which has a meaning of its own in the grammar. Write " + quoted(`\`+shown) +
		" to match the code point itself"
}

type regexReader struct {
	codePoints []rune
	at         int
	depth      int
}

func parseRegex(codePoints []rune) (*node, *parseFailure) {
	reader := &regexReader{codePoints: codePoints}
	parsed, failure := reader.parsePattern()
	if failure != nil {
		return nil, failure
	}
	if reader.at < len(codePoints) {
		return nil, &parseFailure{"closes a group that it never opened", reader.at}
	}
	return parsed, nil
}

func (reader *regexReader) peek(offset int) rune {
	if at := reader.at + offset; at < len(reader.codePoints) {
		return reader.codePoints[at]
	}
	return noCodePoint
}

func (reader *regexReader) take() rune {
	codePoint := reader.peek(0)
	reader.at++
	return codePoint
}

func (reader *regexReader) parsePattern() (*node, *parseFailure) {
	first, failure := reader.parseBranch()
	if failure != nil {
		return nil, failure
	}
	branches := []*node{first}
	for reader.peek(0) == '|' {
		reader.at++
		branch, failure := reader.parseBranch()
		if failure != nil {
			return nil, failure
		}
		branches = append(branches, branch)
	}
	if len(branches) == 1 {
		return branches[0], nil
	}
	return &node{kind: nodeChoice, children: branches}, nil
}

func (reader *regexReader) parseBranch() (*node, *parseFailure) {
	var items []*node
	for next := reader.peek(0); next != noCodePoint && next != '|' && next != ')'; next = reader.peek(0) {
		piece, failure := reader.parsePiece()
		if failure != nil {
			return nil, failure
		}
		items = append(items, piece)
	}
	if len(items) == 1 {
		return items[0], nil
	}
	return &node{kind: nodeSequence, children: items}, nil
}

func (reader *regexReader) parsePiece() (*node, *parseFailure) {
	atom, failure := reader.parseAtom()
	if failure != nil {
		return nil, failure
	}
	repeated, failure := reader.parseRepeat(atom)
	if failure != nil {
		return nil, failure
	}
	next := reader.peek(0)
	if repeated != atom && (next == '*' || next == '+' || next == '?' || next == '{') {
		return nil, &parseFailure{"holds a second repeat " + quoted(string(next)) +
			" after one atom. The grammar allows one repeat for each atom, so it has no lazy or possessive repeats", reader.at}
	}
	return repeated, nil
}

func (reader *regexReader) parseAtom() (*node, *parseFailure) {
	start := reader.at
	codePoint := reader.take()
	switch codePoint {
	case '\\':
		return reader.parseEscape(start)
	case '.':
		return &node{kind: nodeAny}, nil
	case '^', '$':
		return &node{kind: nodeAssert}, nil
	case '[':
		return reader.parseSet(start)
	case '(':
		return reader.parseGroup(start)
	case '<':
		return reader.parseNumberRange(start)
	}
	if isReserved(codePoint) {
		return nil, &parseFailure{reservedHere(codePoint), start}
	}
	return &node{kind: nodeLiteral, codePoint: codePoint}, nil
}

func (reader *regexReader) parseEscape(start int) (*node, *parseFailure) {
	escaped := reader.take()
	if escaped == noCodePoint {
		return nil, &parseFailure{trailingEscape, start}
	}
	if isClassEscape(escaped) {
		return &node{kind: nodeClass}, nil
	}
	if escaped == 'b' {
		return &node{kind: nodeAssert}, nil
	}
	if isASCIIPunctuation(escaped) {
		return &node{kind: nodeLiteral, codePoint: escaped}, nil
	}
	return nil, &parseFailure{unknownEscape(escaped), start}
}

func (reader *regexReader) parseGroup(start int) (*node, *parseFailure) {
	if reader.peek(0) == '?' {
		return nil, &parseFailure{`holds "(?", which opens a lookaround, an inline flag, or a non-capturing group. The grammar leaves out all three`, start}
	}
	reader.depth++
	if reader.depth > maxGroupDepth {
		return nil, &parseFailure{"nests its groups more than " + strconv.Itoa(maxGroupDepth) + " deep", start}
	}
	body, failure := reader.parsePattern()
	if failure != nil {
		return nil, failure
	}
	if reader.peek(0) != ')' {
		return nil, &parseFailure{"opens a group that it never closes", start}
	}
	reader.at++
	reader.depth--
	return body, nil
}

func (reader *regexReader) parseRepeat(atom *node) (*node, *parseFailure) {
	codePoint := reader.peek(0)
	if codePoint == '*' || codePoint == '+' || codePoint == '?' {
		reader.at++
		repeat := &node{kind: nodeRepeat, body: atom, max: unboundedRepeat}
		if codePoint == '+' {
			repeat.min = 1
		}
		if codePoint == '?' {
			repeat.max = 1
		}
		return repeat, nil
	}
	if codePoint != '{' {
		return atom, nil
	}
	start := reader.at
	reader.at++
	low, failure := reader.readCount(start)
	if failure != nil {
		return nil, failure
	}
	high := low
	if reader.peek(0) == ',' {
		reader.at++
		high = unboundedRepeat
		if isDigit(reader.peek(0)) {
			if high, failure = reader.readCount(start); failure != nil {
				return nil, failure
			}
		}
	}
	if reader.peek(0) != '}' {
		return nil, &parseFailure{noCountReason, start}
	}
	reader.at++
	if high != unboundedRepeat && low > high {
		return nil, &parseFailure{"holds the count {" + strconv.Itoa(low) + "," + strconv.Itoa(high) +
			"}, whose lower count is above its upper count", start}
	}
	return &node{kind: nodeRepeat, body: atom, min: low, max: high}, nil
}

func (reader *regexReader) readCount(start int) (int, *parseFailure) {
	if !isDigit(reader.peek(0)) {
		return 0, &parseFailure{noCountReason, start}
	}
	count := 0
	for digit := reader.peek(0); isDigit(digit); digit = reader.peek(0) {
		count = min(count*10+int(digit-'0'), maxRepeatCount+1)
		reader.at++
	}
	if count > maxRepeatCount {
		return 0, &parseFailure{"holds a count above the limit of " + strconv.Itoa(maxRepeatCount), start}
	}
	return count, nil
}

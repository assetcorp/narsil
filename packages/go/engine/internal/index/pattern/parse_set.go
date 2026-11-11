package pattern

import "strconv"

func (reader *regexReader) parseSet(start int) (*node, *parseFailure) {
	negated := reader.peek(0) == '^'
	if negated {
		reader.at++
	}
	var items []setItem
	for {
		codePoint := reader.peek(0)
		if codePoint == noCodePoint {
			return nil, &parseFailure{setNeverClosesReason, start}
		}
		if codePoint == ']' {
			break
		}
		item, failure := reader.parseSetItem()
		if failure != nil {
			return nil, failure
		}
		items = append(items, item)
	}
	reader.at++
	if len(items) == 0 {
		if negated {
			return nil, &parseFailure{negatedEmptySetReason, start}
		}
		return nil, &parseFailure{"holds an empty set", start}
	}
	return &node{kind: nodeSet, negated: negated, setItems: items}, nil
}

func (reader *regexReader) parseSetItem() (setItem, *parseFailure) {
	start := reader.at
	low, lowIsClass, failure := reader.parseSetMember(true)
	if failure != nil {
		return setItem{}, failure
	}
	if lowIsClass {
		return setItem{kind: setClass}, nil
	}
	if reader.peek(0) != '-' || reader.peek(1) == ']' {
		return setItem{kind: setMember, codePoint: low}, nil
	}
	reader.at++
	high, highIsClass, failure := reader.parseSetMember(false)
	if failure != nil {
		return setItem{}, failure
	}
	if highIsClass {
		return setItem{}, &parseFailure{rangeEndsInClassReason, start}
	}
	if low > high {
		return setItem{}, &parseFailure{"holds the set range " + quoted(string(low)+"-"+string(high)) +
			", whose low end is above its high end", start}
	}
	return setItem{kind: setRange}, nil
}

func (reader *regexReader) parseSetMember(classAllowed bool) (rune, bool, *parseFailure) {
	start := reader.at
	codePoint := reader.take()
	if codePoint == noCodePoint {
		return 0, false, &parseFailure{setNeverClosesReason, start}
	}
	if codePoint == '[' || codePoint == ']' || codePoint == '-' {
		shown := string(codePoint)
		return 0, false, &parseFailure{"holds " + quoted(shown) + " inside a set. Write " + quoted(`\`+shown) +
			" to match that code point there", start}
	}
	if codePoint != '\\' {
		return codePoint, false, nil
	}
	escaped := reader.take()
	if escaped == noCodePoint {
		return 0, false, &parseFailure{trailingEscape, start}
	}
	isClass := isClassEscape(escaped)
	if isClass && classAllowed {
		return 0, true, nil
	}
	if isASCIIPunctuation(escaped) {
		return escaped, false, nil
	}
	if isClass {
		return 0, false, &parseFailure{rangeEndsInClassReason, start}
	}
	return 0, false, &parseFailure{unknownEscape(escaped), start}
}

func (reader *regexReader) parseNumberRange(start int) (*node, *parseFailure) {
	low := reader.readDigits()
	hyphen := reader.take()
	high := ""
	if hyphen == '-' {
		high = reader.readDigits()
	}
	closing := reader.take()
	if low == "" || high == "" || closing != '>' {
		return nil, &parseFailure{`holds a "<" that doesn't open a number range such as <1-65535>. Each end of a number range holds from 1 to ` +
			strconv.Itoa(maxNumberRangeDigits) + ` digits. Write "\<" to match the "<" itself`, start}
	}
	if digitsValue(low) > digitsValue(high) {
		return nil, &parseFailure{"holds the number range " + quoted("<"+low+"-"+high+">") +
			", whose low end is above its high end", start}
	}
	expansion, failure := parseRegex([]rune(numberRange(low, high)))
	if failure != nil {
		return nil, failure
	}
	return &node{kind: nodeNumberRange, body: expansion}, nil
}

func (reader *regexReader) readDigits() string {
	var digits []byte
	for digit := reader.peek(0); isDigit(digit); digit = reader.peek(0) {
		if len(digits) == maxNumberRangeDigits {
			return ""
		}
		digits = append(digits, byte(digit))
		reader.at++
	}
	return string(digits)
}

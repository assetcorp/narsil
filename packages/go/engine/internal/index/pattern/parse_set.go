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
	low, lowClass, failure := reader.parseSetMember(true)
	if failure != nil {
		return setItem{}, failure
	}
	if lowClass != nil {
		return *lowClass, nil
	}
	if reader.peek(0) != '-' || reader.peek(1) == ']' {
		return setItem{kind: setMember, codePoint: low}, nil
	}
	reader.at++
	high, highClass, failure := reader.parseSetMember(false)
	if failure != nil {
		return setItem{}, failure
	}
	if highClass != nil {
		return setItem{}, &parseFailure{rangeEndsInClassReason, start}
	}
	if low > high {
		return setItem{}, &parseFailure{"holds the set range " + quoted(string(low)+"-"+string(high)) +
			", whose low end is above its high end", start}
	}
	return setItem{kind: setRange, low: low, high: high}, nil
}

func (reader *regexReader) parseSetMember(classAllowed bool) (rune, *setItem, *parseFailure) {
	start := reader.at
	codePoint := reader.take()
	if codePoint == noCodePoint {
		return 0, nil, &parseFailure{setNeverClosesReason, start}
	}
	if codePoint == '[' || codePoint == ']' || codePoint == '-' {
		shown := string(codePoint)
		return 0, nil, &parseFailure{"holds " + quoted(shown) + " inside a set. Write " + quoted(`\`+shown) +
			" to match that code point there", start}
	}
	if codePoint != '\\' {
		return codePoint, nil, nil
	}
	escaped := reader.take()
	if escaped == noCodePoint {
		return 0, nil, &parseFailure{trailingEscape, start}
	}
	class, isClass := classEscape(escaped)
	if isClass && classAllowed {
		return 0, &setItem{kind: setClass, class: class}, nil
	}
	if isASCIIPunctuation(escaped) {
		return escaped, nil, nil
	}
	if isClass {
		return 0, nil, &parseFailure{rangeEndsInClassReason, start}
	}
	return 0, nil, &parseFailure{unknownEscape(escaped), start}
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

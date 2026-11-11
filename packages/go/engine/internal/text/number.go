package text

import (
	"math"
	"strconv"
)

const (
	plainNotationMaxExponent = 21
	plainNotationMinExponent = -6
	shortestDigitsBufferSize = 32
)

func FormatNumber(value float64) string {
	var buffer [shortestDigitsBufferSize]byte
	return string(AppendNumber(buffer[:0], value))
}

func AppendNumber(destination []byte, value float64) []byte {
	switch {
	case math.IsNaN(value):
		return append(destination, "NaN"...)
	case value == 0:
		return append(destination, '0')
	case math.IsInf(value, 1):
		return append(destination, "Infinity"...)
	case math.IsInf(value, -1):
		return append(destination, "-Infinity"...)
	}
	if value < 0 {
		destination = append(destination, '-')
		value = -value
	}
	var scientificBuffer, digitsBuffer [shortestDigitsBufferSize]byte
	scientific := strconv.AppendFloat(scientificBuffer[:0], value, 'e', -1, 64)
	digits, exponent := splitScientific(scientific, digitsBuffer[:0])
	return appendECMAScriptNotation(destination, digits, exponent+1)
}

func splitScientific(scientific []byte, digits []byte) ([]byte, int) {
	marker := 0
	for marker < len(scientific) && scientific[marker] != 'e' {
		if scientific[marker] != '.' {
			digits = append(digits, scientific[marker])
		}
		marker++
	}
	exponent := 0
	negative := false
	for _, character := range scientific[marker+1:] {
		switch {
		case character == '-':
			negative = true
		case character >= '0' && character <= '9':
			exponent = exponent*10 + int(character-'0')
		}
	}
	if negative {
		exponent = -exponent
	}
	return digits, exponent
}

func appendECMAScriptNotation(destination []byte, digits []byte, pointPosition int) []byte {
	count := len(digits)
	switch {
	case count <= pointPosition && pointPosition <= plainNotationMaxExponent:
		destination = append(destination, digits...)
		for range pointPosition - count {
			destination = append(destination, '0')
		}
		return destination
	case 0 < pointPosition && pointPosition <= plainNotationMaxExponent:
		destination = append(destination, digits[:pointPosition]...)
		destination = append(destination, '.')
		return append(destination, digits[pointPosition:]...)
	case plainNotationMinExponent < pointPosition && pointPosition <= 0:
		destination = append(destination, '0', '.')
		for range -pointPosition {
			destination = append(destination, '0')
		}
		return append(destination, digits...)
	}
	destination = append(destination, digits[0])
	if count > 1 {
		destination = append(destination, '.')
		destination = append(destination, digits[1:]...)
	}
	destination = append(destination, 'e')
	exponent := pointPosition - 1
	if exponent >= 0 {
		destination = append(destination, '+')
	}
	return strconv.AppendInt(destination, int64(exponent), 10)
}

package indexsettings

import (
	"strconv"
	"strings"
	"time"
)

type cronFieldRange struct {
	minimum int
	maximum int
}

var cronFieldRanges = []cronFieldRange{
	{minimum: 0, maximum: 59},
	{minimum: 0, maximum: 23},
	{minimum: 1, maximum: 31},
	{minimum: 1, maximum: 12},
	{minimum: 0, maximum: 6},
}

func cronNumber(digits string) (int, bool) {
	if len(digits) == 0 || len(digits) > MaxScheduleFieldNumberDigits {
		return 0, false
	}
	for index := 0; index < len(digits); index++ {
		if digits[index] < '0' || digits[index] > '9' {
			return 0, false
		}
	}
	value, err := strconv.Atoi(digits)
	return value, err == nil
}

func cronBound(digits string, bounds cronFieldRange) (int, bool) {
	value, ok := cronNumber(digits)
	return value, ok && value >= bounds.minimum && value <= bounds.maximum
}

func cronPartIsValid(part string, bounds cronFieldRange) bool {
	pieces := strings.Split(part, "/")
	if len(pieces) > 2 {
		return false
	}
	if len(pieces) == 2 {
		step, ok := cronNumber(pieces[1])
		if !ok || step < 1 {
			return false
		}
	}
	base := pieces[0]
	if base == "*" {
		return true
	}
	limits := strings.Split(base, "-")
	if len(limits) > 2 {
		return false
	}
	first, ok := cronBound(limits[0], bounds)
	if !ok {
		return false
	}
	if len(limits) == 2 {
		last, lastOK := cronBound(limits[1], bounds)
		return lastOK && last >= first
	}
	return true
}

func IsSchedule(expression string) bool {
	if len(expression) > MaxScheduleLength {
		return false
	}
	fields := strings.Fields(expression)
	if len(fields) != len(cronFieldRanges) {
		return false
	}
	for index, field := range fields {
		for _, part := range strings.Split(field, ",") {
			if !cronPartIsValid(part, cronFieldRanges[index]) {
				return false
			}
		}
	}
	return true
}

func IsTimeZone(zone string) bool {
	if zone == "" || zone == "Local" {
		return false
	}
	_, err := time.LoadLocation(zone)
	return err == nil
}

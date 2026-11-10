package suggestions

import (
	"strconv"
	"strings"
	"time"
)

type Schedule struct {
	minutes       [60]bool
	hours         [24]bool
	daysOfMonth   [32]bool
	months        [13]bool
	daysOfWeek    [7]bool
	dayOfMonthAny bool
	dayOfWeekAny  bool
}

type fieldRange struct{ min, max int }

var scheduleRanges = [5]fieldRange{{0, 59}, {0, 23}, {1, 31}, {1, 12}, {0, 6}}

func scheduleNumber(digits string, bounds fieldRange) (int, bool) {
	if len(digits) == 0 || len(digits) > 2 {
		return 0, false
	}
	for index := 0; index < len(digits); index++ {
		if digits[index] < '0' || digits[index] > '9' {
			return 0, false
		}
	}
	value, err := strconv.Atoi(digits)
	return value, err == nil && value >= bounds.min && value <= bounds.max
}

func parseScheduleField(field string, bounds fieldRange, allowed []bool) bool {
	for _, part := range strings.Split(field, ",") {
		pieces := strings.Split(part, "/")
		if len(pieces) > 2 {
			return false
		}
		step := 1
		if len(pieces) == 2 {
			parsed, ok := scheduleNumber(pieces[1], fieldRange{1, 99})
			if !ok {
				return false
			}
			step = parsed
		}
		start, end := bounds.min, bounds.max
		if pieces[0] != "*" {
			limits := strings.Split(pieces[0], "-")
			if len(limits) > 2 {
				return false
			}
			first, ok := scheduleNumber(limits[0], bounds)
			if !ok {
				return false
			}
			start = first
			switch {
			case len(limits) == 2:
				last, lastOK := scheduleNumber(limits[1], bounds)
				if !lastOK || last < first {
					return false
				}
				end = last
			case len(pieces) == 1:
				end = first
			}
		}
		for value := start; value <= end; value += step {
			allowed[value] = true
		}
	}
	return true
}

func ParseSchedule(expression string) (*Schedule, bool) {
	if len(expression) > MaxScheduleLength {
		return nil, false
	}
	fields := strings.Fields(expression)
	if len(fields) != len(scheduleRanges) {
		return nil, false
	}
	schedule := &Schedule{dayOfMonthAny: fields[2] == "*", dayOfWeekAny: fields[4] == "*"}
	targets := [5][]bool{schedule.minutes[:], schedule.hours[:], schedule.daysOfMonth[:], schedule.months[:],
		schedule.daysOfWeek[:]}
	for index, field := range fields {
		if !parseScheduleField(field, scheduleRanges[index], targets[index]) {
			return nil, false
		}
	}
	return schedule, true
}

func (schedule *Schedule) dayMatches(day time.Time) bool {
	if !schedule.months[int(day.Month())] {
		return false
	}
	monthDay := schedule.daysOfMonth[day.Day()]
	weekDay := schedule.daysOfWeek[int(day.Weekday())]
	if !schedule.dayOfMonthAny && !schedule.dayOfWeekAny {
		return monthDay || weekDay
	}
	return monthDay && weekDay
}

func (schedule *Schedule) matchesOfDay(day time.Time, zone *time.Location) []time.Time {
	instants := make([]time.Time, 0)
	for hour := range 24 {
		if !schedule.hours[hour] {
			continue
		}
		for minute := range 60 {
			if !schedule.minutes[minute] {
				continue
			}
			instant := time.Date(day.Year(), day.Month(), day.Day(), hour, minute, 0, 0, zone)
			if instant.Day() == day.Day() && instant.Hour() == hour && instant.Minute() == minute {
				instants = append(instants, instant)
			}
		}
	}
	return instants
}

func localDay(instant time.Time, zone *time.Location) time.Time {
	local := instant.In(zone)
	return time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.UTC)
}

func (schedule *Schedule) NextMatchAfter(zone *time.Location, after time.Time) (time.Time, bool) {
	first := localDay(after, zone)
	for offset := 0; offset <= ScheduleLookaheadDays; offset++ {
		day := first.AddDate(0, 0, offset)
		if !schedule.dayMatches(day) {
			continue
		}
		for _, instant := range schedule.matchesOfDay(day, zone) {
			if instant.After(after) {
				return instant, true
			}
		}
	}
	return time.Time{}, false
}

func (schedule *Schedule) LatestMatchAtOrBefore(zone *time.Location, at time.Time) (time.Time, bool) {
	first := localDay(at, zone)
	for offset := 0; offset <= ScheduleLookaheadDays; offset++ {
		day := first.AddDate(0, 0, -offset)
		if !schedule.dayMatches(day) {
			continue
		}
		instants := schedule.matchesOfDay(day, zone)
		for index := len(instants) - 1; index >= 0; index-- {
			if !instants[index].After(at) {
				return instants[index], true
			}
		}
	}
	return time.Time{}, false
}

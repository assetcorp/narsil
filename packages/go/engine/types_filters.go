package engine

import "github.com/assetcorp/narsil/packages/go/engine/internal/model"

// FilterValue is one number, string, or boolean that a filter compares with.
type FilterValue = model.FilterValue

// NumberValue returns a filter value holding number.
func NumberValue(number float64) FilterValue {
	return model.NumberValue(number)
}

// TextValue returns a filter value holding text.
func TextValue(text string) FilterValue {
	return model.TextValue(text)
}

// BooleanValue returns a filter value holding boolean.
func BooleanValue(boolean bool) FilterValue {
	return model.BooleanValue(boolean)
}

// RangeBound is one end of a range filter, a number or a string.
type RangeBound = model.RangeBound

// NumberBound returns a range bound holding number.
func NumberBound(number float64) RangeBound {
	return model.NumberBound(number)
}

// TextBound returns a range bound holding text.
func TextBound(text string) RangeBound {
	return model.TextBound(text)
}

// RangeInterval is the low and high bound of a between filter.
type RangeInterval = model.RangeInterval

// NumberInterval is a numeric range of a size filter.
type NumberInterval = model.NumberInterval

// SizeFilter compares the number of values a list field holds.
type SizeFilter = model.SizeFilter

// PatternTolerance sets how many typos a pattern filter forgives.
type PatternTolerance = model.PatternTolerance

// ToleranceEdits returns a tolerance that forgives edits typos.
func ToleranceEdits(edits int) PatternTolerance {
	return model.ToleranceEdits(edits)
}

// ToleranceAuto returns a tolerance that forgives more typos in a longer word.
func ToleranceAuto() PatternTolerance {
	return model.ToleranceAuto()
}

// DistanceUnit is the unit of a geo radius.
type DistanceUnit = model.DistanceUnit

const (
	// DistanceKilometres measures a radius in kilometres.
	DistanceKilometres = model.DistanceKilometres
	// DistanceMiles measures a radius in miles.
	DistanceMiles = model.DistanceMiles
	// DistanceMetres measures a radius in metres.
	DistanceMetres = model.DistanceMetres
)

// GeoPoint is a latitude and a longitude in degrees.
type GeoPoint = model.GeoPoint

// GeoRadius matches the points within a distance of a centre.
type GeoRadius = model.GeoRadius

// GeoPolygon matches the points inside a polygon.
type GeoPolygon = model.GeoPolygon

// FieldFilter holds the conditions on one field, all of which a document must meet.
type FieldFilter = model.FieldFilter

// FilterExpression combines field conditions with and, or, and not.
type FilterExpression = model.FilterExpression

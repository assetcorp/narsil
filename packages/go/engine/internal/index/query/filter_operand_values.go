package query

import (
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

const (
	maxLatitudeDegrees  float64 = 90
	maxLongitudeDegrees float64 = 180
	minPolygonPoints            = 3
	distanceUnitList            = "km, mi, m"
	absentValueText             = "undefined"
)

var (
	latitudeRangeText  = "-" + text.FormatNumber(maxLatitudeDegrees) + " to " + text.FormatNumber(maxLatitudeDegrees)
	longitudeRangeText = "-" + text.FormatNumber(maxLongitudeDegrees) + " to " + text.FormatNumber(maxLongitudeDegrees)
)

func malformedText(candidate string, isText bool) bool {
	return isText && !text.IsWellFormed(candidate)
}

func malformedTexts(texts []string) bool {
	for _, candidate := range texts {
		if !text.IsWellFormed(candidate) {
			return true
		}
	}
	return false
}

func malformedValues(values []model.FilterValue) bool {
	for _, value := range values {
		if malformedText(value.Text()) {
			return true
		}
	}
	return false
}

func requireWellFormedText(fieldPath string, filter *model.FieldFilter) error {
	checks := []struct {
		operator  string
		malformed bool
	}{
		{"eq", malformedText(filter.Eq.Text())},
		{"ne", malformedText(filter.Ne.Text())},
		{"gt", malformedText(filter.Gt.Text())},
		{"lt", malformedText(filter.Lt.Text())},
		{"gte", malformedText(filter.Gte.Text())},
		{"lte", malformedText(filter.Lte.Text())},
		{"between", malformedText(filter.Between.Low.Text()) || malformedText(filter.Between.High.Text())},
		{"in", malformedTexts(filter.In)},
		{"nin", malformedTexts(filter.Nin)},
		{"startsWith", malformedText(filter.StartsWith.Get())},
		{"endsWith", malformedText(filter.EndsWith.Get())},
		{"contains", malformedText(filter.Contains.Get())},
		{"wildcard", malformedText(filter.Wildcard.Get())},
		{"regex", malformedText(filter.Regex.Get())},
		{"containsAll", malformedValues(filter.ContainsAll)},
		{"matchesAny", malformedValues(filter.MatchesAny)},
	}
	for _, check := range checks {
		if check.malformed {
			return invalidOperand(`The text of "`+check.operator+`" on field "`+fieldPath+
				`" holds an unpaired surrogate, the half of a character such as an emoji whose other half is missing, so no stored value can hold it`,
				fieldPath, check.operator)
		}
	}
	return nil
}

func latitude(value float64) bool {
	return value >= -maxLatitudeDegrees && value <= maxLatitudeDegrees
}

func longitude(value float64) bool {
	return value >= -maxLongitudeDegrees && value <= maxLongitudeDegrees
}

func requireRadius(fieldPath string, radius *model.GeoRadius) error {
	if radius == nil {
		return nil
	}
	onField := ` on field "` + fieldPath + `"`
	coordinates := []struct {
		key   string
		value float64
	}{{"lat", radius.Lat}, {"lon", radius.Lon}, {"distance", radius.Distance}}
	for _, coordinate := range coordinates {
		if !finite(coordinate.value) {
			return invalidOperand(`"radius.`+coordinate.key+`"`+onField+" must be a finite number", fieldPath, "radius")
		}
	}
	if _, known := geoUnitMetres[radius.Unit]; !known {
		unit := string(radius.Unit)
		if unit == "" {
			unit = absentValueText
		}
		return invalidOperand(`"radius.unit"`+onField+" must be one of "+distanceUnitList+", and this filter sets "+unit, fieldPath, "radius")
	}
	if radius.Distance < 0 {
		return invalidOperand(`"radius.distance"`+onField+" must be zero or more, and this filter sets "+text.FormatNumber(radius.Distance), fieldPath, "radius")
	}
	if !latitude(radius.Lat) {
		return invalidOperand(`"radius.lat"`+onField+" must be from "+latitudeRangeText+", and this filter sets "+text.FormatNumber(radius.Lat), fieldPath, "radius")
	}
	if !longitude(radius.Lon) {
		return invalidOperand(`"radius.lon"`+onField+" must be from "+longitudeRangeText+", and this filter sets "+text.FormatNumber(radius.Lon), fieldPath, "radius")
	}
	return nil
}

func requirePolygon(fieldPath string, polygon *model.GeoPolygon) error {
	if polygon == nil {
		return nil
	}
	points := polygon.Points
	if len(points) < minPolygonPoints {
		var counted any = len(points)
		if points == nil {
			counted = absentValueText
		}
		return narsilerr.New(narsilerr.CodeSearchInvalidFilter, "A polygon encloses an area only with at least "+strconv.Itoa(minPolygonPoints)+" points",
			map[string]any{"points": counted, "minimum": minPolygonPoints})
	}
	for position, point := range points {
		if !finite(point.Lat) || !finite(point.Lon) {
			return narsilerr.New(narsilerr.CodeSearchInvalidFilter,
				`A polygon point carries a finite "lat" and "lon", and the point at position `+strconv.Itoa(position)+" does not",
				map[string]any{"position": position})
		}
		if !latitude(point.Lat) || !longitude(point.Lon) {
			return narsilerr.New(narsilerr.CodeSearchInvalidFilter,
				`A polygon point must hold a "lat" from `+latitudeRangeText+` and a "lon" from `+longitudeRangeText+`, while the point at position `+
					strconv.Itoa(position)+" holds "+text.FormatNumber(point.Lat)+", "+text.FormatNumber(point.Lon),
				map[string]any{"position": position, "lat": point.Lat, "lon": point.Lon})
		}
	}
	return nil
}

func requireGeoOperands(fieldPath string, filter *model.FieldFilter, _ schema.ParsedFieldType) error {
	if err := requireRadius(fieldPath, filter.Radius); err != nil {
		return err
	}
	return requirePolygon(fieldPath, filter.Polygon)
}

package geo

import (
	"math"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

const distanceUnitList = "km, mi, m"

const absentValueText = "undefined"

var (
	latitudeRangeText  = "-" + text.FormatNumber(maxLatitudeDegrees) + " to " + text.FormatNumber(maxLatitudeDegrees)
	longitudeRangeText = "-" + text.FormatNumber(maxLongitudeDegrees) + " to " + text.FormatNumber(maxLongitudeDegrees)
)

func MetresPerUnit(unit model.DistanceUnit) (float64, bool) {
	switch unit {
	case model.DistanceKilometres:
		return 1_000, true
	case model.DistanceMiles:
		return 1_609.344, true
	case model.DistanceMetres:
		return 1, true
	}
	return 0, false
}

func isFinite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

func isLatitude(value float64) bool {
	return value >= -maxLatitudeDegrees && value <= maxLatitudeDegrees
}

func isLongitude(value float64) bool {
	return value >= -maxLongitudeDegrees && value <= maxLongitudeDegrees
}

func invalidOperand(message, fieldPath, operator string) error {
	return narsilerr.New(narsilerr.CodeSearchInvalidFilter, message, map[string]any{"fieldPath": fieldPath, "operator": operator})
}

func ValidateRadius(fieldPath string, radius *model.GeoRadius) error {
	if radius == nil {
		return nil
	}
	onField := ` on field "` + fieldPath + `"`
	coordinates := []struct {
		key   string
		value float64
	}{{"lat", radius.Lat}, {"lon", radius.Lon}, {"distance", radius.Distance}}
	for _, coordinate := range coordinates {
		if !isFinite(coordinate.value) {
			return invalidOperand(`"radius.`+coordinate.key+`"`+onField+" must be a finite number", fieldPath, "radius")
		}
	}
	if _, known := MetresPerUnit(radius.Unit); !known {
		unit := string(radius.Unit)
		if unit == "" {
			unit = absentValueText
		}
		return invalidOperand(`"radius.unit"`+onField+" must be one of "+distanceUnitList+", and this filter sets "+unit, fieldPath, "radius")
	}
	if radius.Distance < 0 {
		return invalidOperand(`"radius.distance"`+onField+" must be zero or more, and this filter sets "+text.FormatNumber(radius.Distance), fieldPath, "radius")
	}
	if !isLatitude(radius.Lat) {
		return invalidOperand(`"radius.lat"`+onField+" must be from "+latitudeRangeText+", and this filter sets "+text.FormatNumber(radius.Lat), fieldPath, "radius")
	}
	if !isLongitude(radius.Lon) {
		return invalidOperand(`"radius.lon"`+onField+" must be from "+longitudeRangeText+", and this filter sets "+text.FormatNumber(radius.Lon), fieldPath, "radius")
	}
	return nil
}

func ValidatePolygon(fieldPath string, polygon *model.GeoPolygon) error {
	if polygon == nil {
		return nil
	}
	points := polygon.Points
	if len(points) > maxFilterListLength {
		return invalidOperand(`"polygon" on field "`+fieldPath+`" holds `+strconv.Itoa(len(points))+" values, while a filter list holds at most "+strconv.Itoa(maxFilterListLength), fieldPath, "polygon")
	}
	if len(points) < minPolygonPoints {
		var counted any = len(points)
		if points == nil {
			counted = absentValueText
		}
		return narsilerr.New(narsilerr.CodeSearchInvalidFilter, "A polygon encloses an area only with at least "+strconv.Itoa(minPolygonPoints)+" points",
			map[string]any{"points": counted, "minimum": minPolygonPoints})
	}
	for position, point := range points {
		if !isFinite(point.Lat) || !isFinite(point.Lon) {
			return narsilerr.New(narsilerr.CodeSearchInvalidFilter,
				`A polygon point carries a finite "lat" and "lon", and the point at position `+strconv.Itoa(position)+" does not",
				map[string]any{"position": position})
		}
		if !isLatitude(point.Lat) || !isLongitude(point.Lon) {
			return narsilerr.New(narsilerr.CodeSearchInvalidFilter,
				`A polygon point must hold a "lat" from `+latitudeRangeText+` and a "lon" from `+longitudeRangeText+`, while the point at position `+
					strconv.Itoa(position)+" holds "+text.FormatNumber(point.Lat)+", "+text.FormatNumber(point.Lon),
				map[string]any{"position": position, "lat": point.Lat, "lon": point.Lon})
		}
	}
	return nil
}

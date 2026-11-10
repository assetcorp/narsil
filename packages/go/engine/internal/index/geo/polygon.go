package geo

import (
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

type locationTest func(lat, lon float64) bool

func signedArea(polygon []model.GeoPoint) float64 {
	area := 0.0
	for at, previous := 0, len(polygon)-1; at < len(polygon); previous, at = at, at+1 {
		area += float64(polygon[previous].Lon*polygon[at].Lat) - float64(polygon[at].Lon*polygon[previous].Lat)
	}
	return area
}

func crossesAntimeridian(polygon []model.GeoPoint) bool {
	west := math.Inf(1)
	east := math.Inf(-1)
	for _, point := range polygon {
		if point.Lon < west {
			west = point.Lon
		}
		if point.Lon > east {
			east = point.Lon
		}
	}
	return east-west >= antimeridianSpanDegrees && signedArea(polygon) < 0
}

func eastward(lon float64) float64 {
	if lon < 0 {
		return lon + fullTurnDegrees
	}
	return lon
}

func polygonContainment(polygon []model.GeoPoint) locationTest {
	count := len(polygon)
	if count < minPolygonPoints {
		return func(float64, float64) bool { return false }
	}
	unwrap := crossesAntimeridian(polygon)
	lats := make([]float64, count)
	lons := make([]float64, count)
	for at, point := range polygon {
		lats[at] = point.Lat
		lons[at] = point.Lon
		if unwrap {
			lons[at] = eastward(point.Lon)
		}
	}
	edges := buildLongitudeEdgeTree(lons)
	return func(lat, rawLon float64) bool {
		lon := rawLon
		if unwrap {
			lon = eastward(rawLon)
		}
		inside := false
		edges.forEachEdgeSpanning(lon, func(from, to int32) {
			intersectLat := lats[from] + float64(((lats[to]-lats[from])/(lons[to]-lons[from]))*(lon-lons[from]))
			if lat < intersectLat {
				inside = !inside
			}
		})
		return inside
	}
}

func polygonBoxes(polygon []model.GeoPoint) []locationBox {
	if len(polygon) < minPolygonPoints {
		return nil
	}
	unwrap := crossesAntimeridian(polygon)
	south := math.Inf(1)
	north := math.Inf(-1)
	west := math.Inf(1)
	east := math.Inf(-1)
	for _, point := range polygon {
		lon := point.Lon
		if unwrap {
			lon = eastward(point.Lon)
		}
		south = math.Min(south, point.Lat)
		north = math.Max(north, point.Lat)
		west = math.Min(west, lon)
		east = math.Max(east, lon)
	}
	if west >= maxLongitudeDegrees {
		return longitudeBoxes(south, north, west-fullTurnDegrees, east-fullTurnDegrees)
	}
	return longitudeBoxes(south, north, west, east)
}

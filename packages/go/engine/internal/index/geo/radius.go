package geo

import (
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

const (
	exactBandLow     float64 = 1 - radiusExactCheckBandRatio
	exactBandHigh    float64 = 1 + radiusExactCheckBandRatio
	geodesicBandLow  float64 = 1 - radiusGeodesicBandRatio
	geodesicBandHigh float64 = 1 + radiusGeodesicBandRatio
)

func radiusBoxes(lat, lon, distanceMetres float64) []locationBox {
	angle := float64((distanceMetres/earthRadiusMetres)*radiusBoxMarginRatio) + radiusBoxMarginRadians
	angleDegrees := angle / degreesToRadians
	south := lat - angleDegrees
	north := lat + angleDegrees
	if angle >= math.Pi || south <= -maxLatitudeDegrees || north >= maxLatitudeDegrees {
		return []locationBox{{
			south: math.Max(south, -maxLatitudeDegrees),
			north: math.Min(north, maxLatitudeDegrees),
			west:  -maxLongitudeDegrees,
			east:  maxLongitudeDegrees,
		}}
	}
	spreadSine := math.Min(1, core.Sin(angle)/core.Cos(lat*degreesToRadians))
	spread := core.Asin(spreadSine) / degreesToRadians
	return longitudeBoxes(south, north, lon-spread, lon+spread)
}

func exactHaversineTest(lat, lon, distanceMetres float64, angle float64, banded bool) locationTest {
	origin := newHaversineOrigin(lat, lon)
	surelyWithin := math.Inf(-1)
	surelyBeyond := math.Inf(1)
	if banded {
		edge := haversineHalfChordOfAngle(angle)
		surelyWithin = edge * exactBandLow
		surelyBeyond = edge * exactBandHigh
	}
	return func(candidateLat, candidateLon float64) bool {
		halfChord := origin.halfChord(candidateLat, candidateLon)
		if halfChord < surelyWithin {
			return true
		}
		if halfChord > surelyBeyond {
			return false
		}
		return haversineDistanceOfChord(halfChord) <= distanceMetres
	}
}

func boundedTest(lat, lon, surelyWithin, surelyBeyond float64, exact func() locationTest) locationTest {
	origin := newHalfChordOrigin(lat, lon)
	var exactly locationTest
	return func(candidateLat, candidateLon float64) bool {
		if lower, upper, bounded := origin.bound(candidateLat, candidateLon); bounded {
			if upper < surelyWithin {
				return true
			}
			if lower > surelyBeyond {
				return false
			}
		}
		if exactly == nil {
			exactly = exact()
		}
		return exactly(candidateLat, candidateLon)
	}
}

func haversineTest(lat, lon, distanceMetres float64) locationTest {
	angle := distanceMetres / earthRadiusMetres
	if angle < radiusBandMinAngleRadians || angle > radiusBandMaxAngleRadians {
		return exactHaversineTest(lat, lon, distanceMetres, angle, false)
	}
	edgeSquare := (angle / 2) * (angle / 2)
	if edgeSquare > halfChordBoundMaxSquare {
		return exactHaversineTest(lat, lon, distanceMetres, angle, true)
	}
	surelyWithin := sineSquareLow(edgeSquare) * exactBandLow * relativeSlackLow
	surelyBeyond := sineSquareHigh(edgeSquare) * exactBandHigh * relativeSlackHigh
	return boundedTest(lat, lon, surelyWithin, surelyBeyond, func() locationTest {
		return exactHaversineTest(lat, lon, distanceMetres, angle, true)
	})
}

func exactVincentyTest(lat, lon, distanceMetres float64) locationTest {
	origin := newVincentyOrigin(lat, lon)
	return func(candidateLat, candidateLon float64) bool {
		return origin.distance(candidateLat, candidateLon) <= distanceMetres
	}
}

func vincentyTest(lat, lon, distanceMetres float64) locationTest {
	angle := distanceMetres / earthRadiusMetres
	if distanceMetres < radiusGeodesicBandMinMetres || angle > radiusGeodesicBandMaxAngleRadians {
		return exactVincentyTest(lat, lon, distanceMetres)
	}
	nearest := (distanceMetres * geodesicBandLow) / wgs84LargestCurvatureRadiusMetres / 2
	farthest := (distanceMetres * geodesicBandHigh) / wgs84SmallestCurvatureRadiusMetres / 2
	surelyWithin := sineSquareLow(nearest*nearest) * relativeSlackLow
	surelyBeyond := sineSquareHigh(farthest*farthest) * relativeSlackHigh
	return boundedTest(lat, lon, surelyWithin, surelyBeyond, func() locationTest {
		return exactVincentyTest(lat, lon, distanceMetres)
	})
}

func radiusCandidateTest(lat, lon, distanceMetres float64, highPrecision bool) locationTest {
	if highPrecision {
		return vincentyTest(lat, lon, distanceMetres)
	}
	return haversineTest(lat, lon, distanceMetres)
}

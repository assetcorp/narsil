package geo

import (
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

type haversineOrigin struct {
	lat            float64
	lon            float64
	latitudeCosine float64
}

func newHaversineOrigin(lat, lon float64) haversineOrigin {
	return haversineOrigin{lat: lat, lon: lon, latitudeCosine: core.Cos(lat * degreesToRadians)}
}

func (origin haversineOrigin) halfChord(lat, lon float64) float64 {
	phi2 := lat * degreesToRadians
	deltaPhi := (lat - origin.lat) * degreesToRadians
	deltaLambda := (lon - origin.lon) * degreesToRadians
	halfDeltaPhi := core.Sin(deltaPhi / 2)
	halfDeltaLambda := core.Sin(deltaLambda / 2)
	return float64(halfDeltaPhi*halfDeltaPhi) +
		float64(origin.latitudeCosine*core.Cos(phi2)*halfDeltaLambda*halfDeltaLambda)
}

func haversineHalfChordOfAngle(angle float64) float64 {
	halfChordSine := core.Sin(angle / 2)
	return halfChordSine * halfChordSine
}

func haversineDistanceOfChord(halfChord float64) float64 {
	angle := 2 * core.Atan2(math.Sqrt(halfChord), math.Sqrt(1-halfChord))
	return earthRadiusMetres * angle
}

func HaversineDistance(lat1, lon1, lat2, lon2 float64) float64 {
	return haversineDistanceOfChord(newHaversineOrigin(lat1, lon1).halfChord(lat2, lon2))
}

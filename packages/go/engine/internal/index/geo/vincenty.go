package geo

import (
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

const (
	wgs84MajorAxisMetres             float64 = 6_378_137.0
	wgs84InverseFlattening           float64 = 298.257223563
	wgs84Flattening                  float64 = 1 / wgs84InverseFlattening
	wgs84MinorAxisMetres             float64 = wgs84MajorAxisMetres * (1 - wgs84Flattening)
	wgs84SecondEccentricityNumerator float64 = wgs84MajorAxisMetres*wgs84MajorAxisMetres - wgs84MinorAxisMetres*wgs84MinorAxisMetres
	wgs84MinorAxisSquare             float64 = wgs84MinorAxisMetres * wgs84MinorAxisMetres
)

type vincentyOrigin struct {
	lat   float64
	lon   float64
	sinU1 float64
	cosU1 float64
}

func newVincentyOrigin(lat, lon float64) vincentyOrigin {
	reducedLatitude := core.Atan((1 - wgs84Flattening) * core.Tan(lat*degreesToRadians))
	return vincentyOrigin{lat: lat, lon: lon, sinU1: core.Sin(reducedLatitude), cosU1: core.Cos(reducedLatitude)}
}

func (origin vincentyOrigin) distance(lat2, lon2 float64) float64 {
	sinU1, cosU1 := origin.sinU1, origin.cosU1
	phi2 := lat2 * degreesToRadians
	longitudeDifference := (lon2 - origin.lon) * degreesToRadians
	reducedLatitude := core.Atan((1 - wgs84Flattening) * core.Tan(phi2))
	sinU2 := core.Sin(reducedLatitude)
	cosU2 := core.Cos(reducedLatitude)

	lambda := longitudeDifference
	var sinSigma, cosSigma, sigma, sinAlpha, cos2Alpha, cos2SigmaM float64
	iterations := vincentyMaxIterations
	for {
		sinLambda := core.Sin(lambda)
		cosLambda := core.Cos(lambda)
		term1 := cosU2 * sinLambda
		term2 := float64(cosU1*sinU2) - float64(sinU1*cosU2*cosLambda)
		sinSigma = math.Sqrt(float64(term1*term1) + float64(term2*term2))
		if sinSigma == 0 {
			return 0
		}
		cosSigma = float64(sinU1*sinU2) + float64(cosU1*cosU2*cosLambda)
		sigma = core.Atan2(sinSigma, cosSigma)
		sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma
		cos2Alpha = 1 - float64(sinAlpha*sinAlpha)
		cos2SigmaM = 0
		if cos2Alpha != 0 {
			cos2SigmaM = cosSigma - (2*sinU1*sinU2)/cos2Alpha
		}
		correction := (wgs84Flattening / 16) * cos2Alpha * (4 + float64(wgs84Flattening*(4-float64(3*cos2Alpha))))
		previousLambda := lambda
		lambda = longitudeDifference + float64((1-correction)*wgs84Flattening*sinAlpha*
			(sigma+float64(correction*sinSigma*
				(cos2SigmaM+float64(correction*cosSigma*(-1+float64(2*cos2SigmaM*cos2SigmaM)))))))
		if !(math.Abs(lambda-previousLambda) > vincentyConvergenceThreshold) {
			break
		}
		iterations--
		if iterations <= 0 {
			break
		}
	}
	if iterations == 0 {
		return HaversineDistance(origin.lat, origin.lon, lat2, lon2)
	}

	uSquare := (cos2Alpha * wgs84SecondEccentricityNumerator) / wgs84MinorAxisSquare
	seriesA := 1 + float64((uSquare/16384)*
		(4096+float64(uSquare*(-768+float64(uSquare*(320-float64(175*uSquare)))))))
	seriesB := (uSquare / 1024) * (256 + float64(uSquare*(-128+float64(uSquare*(74-float64(47*uSquare))))))
	deltaSigma := seriesB * sinSigma *
		(cos2SigmaM + float64((seriesB/4)*
			(float64(cosSigma*(-1+float64(2*cos2SigmaM*cos2SigmaM)))-
				float64((seriesB/6)*cos2SigmaM*(-3+float64(4*sinSigma*sinSigma))*(-3+float64(4*cos2SigmaM*cos2SigmaM))))))
	return wgs84MinorAxisMetres * seriesA * (sigma - deltaSigma)
}

func VincentyDistance(lat1, lon1, lat2, lon2 float64) float64 {
	return newVincentyOrigin(lat1, lon1).distance(lat2, lon2)
}

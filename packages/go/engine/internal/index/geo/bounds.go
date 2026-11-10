package geo

import "math"

const (
	cosineSecond      float64 = -1.0 / 2
	cosineFourth      float64 = 1.0 / 24
	cosineSixth       float64 = -1.0 / 720
	cosineEighth      float64 = 1.0 / 40_320
	cosineTenth       float64 = -1.0 / 3_628_800
	cosineTwelfth     float64 = 1.0 / 479_001_600
	cosineFourteenth  float64 = -1.0 / 87_178_291_200
	cosineSixteenth   float64 = 1.0 / 20_922_789_888_000
	sineThird         float64 = -1.0 / 6
	sineFifth         float64 = 1.0 / 120
	sineSeventh       float64 = -1.0 / 5_040
	sineNinth         float64 = 1.0 / 362_880
	sineEleventh      float64 = -1.0 / 39_916_800
	sineThirteenth    float64 = 1.0 / 6_227_020_800
	sineFifteenth     float64 = -1.0 / 1_307_674_368_000
	sineSeventeenth   float64 = 1.0 / 355_687_428_096_000
	sineSquareFourth  float64 = 1.0 / 3
	sineSquareSixth   float64 = 2.0 / 45
	relativeSlackLow  float64 = 1 - halfChordBoundRelativeSlack
	relativeSlackHigh float64 = 1 + halfChordBoundRelativeSlack
)

type halfChordOrigin struct {
	lat        float64
	lon        float64
	phi        float64
	cosineLow  float64
	cosineHigh float64
	sineLow    float64
	sineHigh   float64
}

func sineSquareLow(square float64) float64 {
	return square - float64(square*square*sineSquareFourth)
}

func sineSquareHigh(square float64) float64 {
	return sineSquareLow(square) + float64(square*square*square*sineSquareSixth)
}

func newHalfChordOrigin(lat, lon float64) halfChordOrigin {
	phi := lat * degreesToRadians
	square := phi * phi
	squareFourth := square * square * (square * square)
	cosine := 1 + float64(square*
		(cosineSecond+float64(square*
			(cosineFourth+float64(square*
				(cosineSixth+float64(square*
					(cosineEighth+float64(square*
						(cosineTenth+float64(square*
							(cosineTwelfth+float64(square*cosineFourteenth)))))))))))))
	magnitude := math.Abs(phi)
	sine := magnitude * (1 + float64(square*
		(sineThird+float64(square*
			(sineFifth+float64(square*
				(sineSeventh+float64(square*
					(sineNinth+float64(square*
						(sineEleventh+float64(square*
							(sineThirteenth+float64(square*sineFifteenth))))))))))))))
	sineHigh := sine + float64(magnitude*squareFourth*squareFourth*sineSeventeenth) + cosineBoundAbsoluteSlack
	sineLow := sine - cosineBoundAbsoluteSlack
	origin := halfChordOrigin{
		lat:        lat,
		lon:        lon,
		phi:        phi,
		cosineLow:  math.Max(0, cosine-cosineBoundAbsoluteSlack),
		cosineHigh: cosine + float64(squareFourth*squareFourth*cosineSixteenth) + cosineBoundAbsoluteSlack,
		sineLow:    sineLow,
		sineHigh:   sineHigh,
	}
	if phi < 0 {
		origin.sineLow = -sineHigh
		origin.sineHigh = -sineLow
	}
	return origin
}

func (origin *halfChordOrigin) bound(lat, lon float64) (lower, upper float64, bounded bool) {
	halfDeltaPhi := ((lat - origin.lat) * degreesToRadians) / 2
	halfDeltaLambda := ((lon - origin.lon) * degreesToRadians) / 2
	step := float64(lat*degreesToRadians) - origin.phi
	phiSquare := halfDeltaPhi * halfDeltaPhi
	lambdaSquare := halfDeltaLambda * halfDeltaLambda
	stepSquare := step * step
	if !(phiSquare <= halfChordBoundMaxSquare && lambdaSquare <= halfChordBoundMaxSquare && stepSquare <= halfChordBoundMaxSquare) {
		return 0, 0, false
	}
	stepCosineLow := 1 - stepSquare/2
	stepCosineHigh := stepCosineLow + (stepSquare*stepSquare)/24
	stepSine := step - (step*stepSquare)/6
	stepSineEnd := stepSine + (step*stepSquare*stepSquare)/120
	stepSineLow := math.Min(stepSine, stepSineEnd)
	stepSineHigh := math.Max(stepSine, stepSineEnd)
	lowLow := origin.sineLow * stepSineLow
	lowHigh := origin.sineLow * stepSineHigh
	highLow := origin.sineHigh * stepSineLow
	highHigh := origin.sineHigh * stepSineHigh
	turnLow := math.Min(math.Min(lowLow, lowHigh), math.Min(highLow, highHigh))
	turnHigh := math.Max(math.Max(lowLow, lowHigh), math.Max(highLow, highHigh))
	cosineLow := math.Max(0, float64(origin.cosineLow*stepCosineLow)-turnHigh-cosineBoundAbsoluteSlack)
	cosineHigh := float64(origin.cosineHigh*stepCosineHigh) - turnLow + cosineBoundAbsoluteSlack
	lower = (sineSquareLow(phiSquare) + float64(origin.cosineLow*cosineLow*sineSquareLow(lambdaSquare))) * relativeSlackLow
	upper = (sineSquareHigh(phiSquare) + float64(origin.cosineHigh*cosineHigh*sineSquareHigh(lambdaSquare))) * relativeSlackHigh
	return lower, upper, true
}

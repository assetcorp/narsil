package geo

import "math"

const (
	degreesToRadians float64 = float64(math.Pi) / 180

	maxLatitudeDegrees      float64 = 90
	maxLongitudeDegrees     float64 = 180
	minPolygonPoints                = 3
	antimeridianSpanDegrees float64 = 180
	fullTurnDegrees         float64 = 360

	earthRadiusMetres float64 = 6_371_008.8

	locationCodeBitsPerAxis = 26
	maxCoveringCells        = 16

	pendingRemovalMergeFloor   float64 = 64
	pendingRemovalMergeDivisor float64 = 256

	maxFilterListLength = 65_536

	radiusBoxMarginRatio               float64 = 1.02
	radiusBoxMarginRadians             float64 = 1e-9
	radiusExactCheckBandRatio          float64 = 1e-9
	radiusBandMinAngleRadians          float64 = 1e-100
	radiusBandMaxAngleRadians          float64 = 3
	radiusGeodesicBandRatio            float64 = 1e-5
	radiusGeodesicBandMinMetres        float64 = 10
	radiusGeodesicBandMaxAngleRadians  float64 = 0.5
	wgs84LargestCurvatureRadiusMetres  float64 = 6_399_594
	wgs84SmallestCurvatureRadiusMetres float64 = 6_335_439
	halfChordBoundMaxSquare            float64 = 1
	cosineBoundAbsoluteSlack           float64 = 4e-15
	halfChordBoundRelativeSlack        float64 = 1e-12

	vincentyMaxIterations                = 200
	vincentyConvergenceThreshold float64 = 1e-12
)

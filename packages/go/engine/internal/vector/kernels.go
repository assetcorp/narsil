package vector

import (
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

func laneSum(lanes [4]float32) float32 {
	return float32(lanes[0]+lanes[1]) + float32(lanes[2]+lanes[3])
}

func dotOf(left, right []float32) float64 {
	var first, second, third, fourth [4]float32
	length := min(len(left), len(right))
	wideEnd := length &^ 15
	index := 0
	for ; index < wideEnd; index += 16 {
		for lane := range 4 {
			first[lane] = first[lane] + float32(left[index+lane]*right[index+lane])
			second[lane] = second[lane] + float32(left[index+4+lane]*right[index+4+lane])
			third[lane] = third[lane] + float32(left[index+8+lane]*right[index+8+lane])
			fourth[lane] = fourth[lane] + float32(left[index+12+lane]*right[index+12+lane])
		}
	}
	for ; index < length&^3; index += 4 {
		for lane := range 4 {
			first[lane] = first[lane] + float32(left[index+lane]*right[index+lane])
		}
	}
	var combined [4]float32
	for lane := range 4 {
		combined[lane] = float32(first[lane]+second[lane]) + float32(third[lane]+fourth[lane])
	}
	sum := laneSum(combined)
	for ; index < length; index++ {
		sum = sum + float32(left[index]*right[index])
	}
	return float64(sum)
}

func squaredDistanceOf(left, right []float32) float64 {
	var lanes [4]float32
	length := min(len(left), len(right))
	index := 0
	for ; index < length&^3; index += 4 {
		for lane := range 4 {
			difference := left[index+lane] - right[index+lane]
			lanes[lane] = lanes[lane] + float32(difference*difference)
		}
	}
	sum := laneSum(lanes)
	for ; index < length; index++ {
		difference := left[index] - right[index]
		sum = sum + float32(difference*difference)
	}
	return float64(sum)
}

func plainScore(query []float32, queryMagnitude float64, vector []float32, metric model.VectorMetric) float64 {
	switch metric {
	case model.MetricDotProduct:
		return dotOf(query, vector)
	case model.MetricEuclidean:
		return 1 / (1 + math.Sqrt(squaredDistanceOf(query, vector)))
	}
	vectorMagnitude := magnitudeOf(vector)
	if queryMagnitude == 0 || vectorMagnitude == 0 {
		return 0
	}
	return 1 - (1 - dotOf(query, vector)/float64(queryMagnitude*vectorMagnitude))
}

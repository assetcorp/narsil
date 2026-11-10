package core

/*
#include <stdint.h>
#include "native/include/narsil_math.h"
#include "native/src/math/fdlibm.h"
*/
import "C"

type MathFunction uint32

const (
	MathLog   MathFunction = C.NARSIL_MATH_LOG
	MathSin   MathFunction = C.NARSIL_MATH_SIN
	MathCos   MathFunction = C.NARSIL_MATH_COS
	MathTan   MathFunction = C.NARSIL_MATH_TAN
	MathAsin  MathFunction = C.NARSIL_MATH_ASIN
	MathAtan  MathFunction = C.NARSIL_MATH_ATAN
	MathAtan2 MathFunction = C.NARSIL_MATH_ATAN2
)

func ApplyMath(function MathFunction, first, second, results []float64) error {
	if len(first) != len(results) || (function == MathAtan2 && len(second) != len(results)) {
		return &StatusError{Operation: "applyMath", Status: StatusInvalidArgument}
	}
	if len(results) == 0 {
		return nil
	}
	var held pins
	defer held.release()
	batch := C.narsil_math_batch{
		first:   (*C.double)(pinned(&held, first)),
		second:  (*C.double)(pinned(&held, second)),
		results: (*C.double)(pinned(&held, results)),
		count:   C.size_t(len(results)),
	}
	return statusError("applyMath", C.narsil_math_apply(C.narsil_math_function(function), &batch))
}

func Ln(value float64) float64 {
	return float64(C.fdlibm_log(C.double(value)))
}

func Sin(value float64) float64 {
	return float64(C.fdlibm_sin(C.double(value)))
}

func Cos(value float64) float64 {
	return float64(C.fdlibm_cos(C.double(value)))
}

func Tan(value float64) float64 {
	return float64(C.fdlibm_tan(C.double(value)))
}

func Asin(value float64) float64 {
	return float64(C.fdlibm_asin(C.double(value)))
}

func Atan(value float64) float64 {
	return float64(C.fdlibm_atan(C.double(value)))
}

func Atan2(rise, run float64) float64 {
	return float64(C.fdlibm_atan2(C.double(rise), C.double(run)))
}

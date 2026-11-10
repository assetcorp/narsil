package core

/*
#include <stdint.h>
#include "native/include/narsil_math.h"
*/
import "C"

import "math"

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

func mathOf(function MathFunction, first, second float64) float64 {
	values := []float64{first, second, 0}
	if err := ApplyMath(function, values[:1], values[1:2], values[2:]); err != nil {
		return math.NaN()
	}
	return values[2]
}

func Ln(value float64) float64 {
	return mathOf(MathLog, value, 0)
}

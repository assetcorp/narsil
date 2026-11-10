package vector

import (
	"errors"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

func PageFailure(fault *core.PageError, file string, section string) error {
	code := narsilerr.CodePersistenceLoadFailed
	if fault.Status == core.StatusPageCorrupt {
		code = narsilerr.CodePersistenceCrcMismatch
	}
	return narsilerr.Wrap(code,
		`The core cannot read page `+strconv.FormatUint(fault.Fault.Page, 10)+` of section "`+section+`" of "`+file+`"`,
		fault, map[string]any{"path": file, "section": section, "page": float64(fault.Fault.Page),
			"status": fault.Status.String()})
}

func coreFailure(operation string, err error) error {
	if _, ok := narsilerr.As(err); ok {
		return err
	}
	var fault *core.PageError
	if errors.As(err, &fault) {
		return PageFailure(fault, "", strconv.FormatUint(fault.Fault.Section, 10))
	}
	if core.StatusOf(err) == core.StatusOutOfMemory {
		return narsilerr.Wrap(narsilerr.CodePartitionCapacityExceeded,
			"the native search core ran out of memory while it worked on a vector field", err,
			map[string]any{"operation": operation})
	}
	return narsilerr.Wrap(narsilerr.CodeWorkerActionFailed,
		"the native search core refused an operation on a vector field", err,
		map[string]any{"operation": operation})
}

func dimensionMismatch(expected, received int) error {
	failure := narsilerr.Newf(narsilerr.CodeVectorDimensionMismatch,
		"Vector dimension mismatch: expected %d, got %d", expected, received)
	failure.Details["expected"] = float64(expected)
	failure.Details["received"] = float64(received)
	return failure
}

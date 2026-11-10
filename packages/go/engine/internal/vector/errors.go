package vector

import (
	"errors"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

func coreFailure(operation string, err error) error {
	if _, ok := narsilerr.As(err); ok {
		return err
	}
	var status *core.StatusError
	if errors.As(err, &status) && status.Status == core.StatusOutOfMemory {
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

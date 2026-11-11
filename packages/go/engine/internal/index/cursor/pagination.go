package cursor

import (
	"fmt"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

func ClampRowCount(value model.Optional[int], fallback int) int {
	if count, set := value.Get(); set {
		return max(0, count)
	}
	return fallback
}

func ClampLimit(limit model.Optional[int]) int {
	return ClampRowCount(limit, DefaultLimit)
}

func ClampOffset(offset int) int {
	return max(0, offset)
}

func RequireWithinResultWindow(limit, offset int) error {
	depth := float64(offset) + float64(limit)
	if depth <= ResultWindow {
		return nil
	}
	return narsilerr.New(
		narsilerr.CodeSearchResultWindowExceeded,
		fmt.Sprintf("A request reaches the first %d results, and offset + limit is %s. Page past that with the cursor each result carries", ResultWindow, text.FormatNumber(depth)),
		map[string]any{"limit": limit, "offset": offset, "window": ResultWindow},
	)
}

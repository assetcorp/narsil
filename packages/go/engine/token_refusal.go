package engine

import (
	"errors"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

func refusedTokensAs(err error, code string) error {
	var refused *analysis.TokenPositionError
	if err == nil || !errors.As(err, &refused) {
		return err
	}
	return narsilerr.New(code, refused.Error(), map[string]any{"position": refused.Position})
}

func documentTokensRefused(err error) error {
	return refusedTokensAs(err, narsilerr.CodeDocValidationFailed)
}

func queryTokensRefused(err error) error {
	return refusedTokensAs(err, narsilerr.CodeConfigInvalid)
}

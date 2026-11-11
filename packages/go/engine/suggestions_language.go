package engine

import (
	"context"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type analysisChanger interface {
	ChangeAnalysis(ctx context.Context, indexName string, change model.AnalysisChange) error
}

func (runtime *suggestionsRuntime) alignLanguage(ctx context.Context, name, language string) error {
	if changer, changes := any(runtime.n).(analysisChanger); changes {
		return changer.ChangeAnalysis(ctx, name, model.AnalysisChange{Language: model.Some(language)})
	}
	return narsilerr.New(narsilerr.CodeConfigInvalid, `Index "`+name+
		`" analyses text in another language than its source index, and this engine cannot change its analysis`,
		map[string]any{"indexName": name})
}

package index

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

type AnalysedQuery struct {
	ix   *Index
	pass *analysis.Pass
}

func (ix *Index) AnalyseQuery(request model.QueryParams) (*AnalysedQuery, error) {
	prepared, err := ix.settings.Analyzer.Prepare()
	if err != nil {
		return nil, err
	}
	pass := prepared.Remembering()
	if request.Highlight != nil {
		_, _ = pass.Tokens(request.Term, analysis.QueryOptions)
	}
	if !isBlank(request.Term) && (request.Highlight != nil || !searchModesOf(&request).vectorOnly) {
		_, _ = analyseTerm(request.Term, request.Prefix, pass)
	}
	return &AnalysedQuery{ix: ix, pass: pass}, nil
}

func (ix *Index) queryPass(options QueryOptions) (*analysis.Pass, error) {
	if analysed := options.Analysed; analysed != nil && analysed.ix == ix {
		return analysed.pass, nil
	}
	pass, err := ix.settings.Analyzer.Prepare()
	if err != nil {
		return nil, err
	}
	return pass.Remembering(), nil
}

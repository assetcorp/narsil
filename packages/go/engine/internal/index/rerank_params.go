package index

import (
	"strconv"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const (
	DefaultRerankWindow = 100
	MinRerankWindow     = 1
)

type rerankPlan struct {
	adapter string
	fields  []string
	query   string
	window  int
}

func rerankInvalid(message string, details map[string]any) error {
	if details == nil {
		details = map[string]any{}
	}
	return narsilerr.New(narsilerr.CodeRerankConfigInvalid, message, details)
}

func (ix *Index) requireRerankTextFields(fields []string) ([]string, error) {
	if len(fields) == 0 {
		return nil, rerankInvalid("rerank.fields must list at least one text field", nil)
	}
	checked := make([]string, 0, len(fields))
	seen := make(map[string]struct{}, len(fields))
	for _, field := range fields {
		declared, found := ix.settings.Schema.Field(field)
		if !found || !declared.IsStringValued() {
			return nil, rerankInvalid(`rerank.fields gives "`+field+`", which the schema does not declare as a text field`,
				map[string]any{"field": field})
		}
		if _, repeated := seen[field]; repeated {
			return nil, rerankInvalid(`rerank.fields gives "`+field+`" more than once`, map[string]any{"field": field})
		}
		seen[field] = struct{}{}
		checked = append(checked, field)
	}
	return checked, nil
}

func requireRerankWindow(window model.Optional[int], maxWindow int, hybridDepth model.Optional[int]) (int, error) {
	requested, set := window.Get()
	depth, fused := hybridDepth.Get()
	if !set {
		chosen := min(DefaultRerankWindow, maxWindow)
		if fused {
			chosen = min(chosen, depth)
		}
		return chosen, nil
	}
	if requested < MinRerankWindow || requested > maxWindow {
		return 0, rerankInvalid("rerank.window must be a whole number from "+strconv.Itoa(MinRerankWindow)+" to "+strconv.Itoa(maxWindow),
			map[string]any{"window": requested, "maxRerankWindow": maxWindow})
	}
	if fused && requested > depth {
		return 0, rerankInvalid("rerank.window is "+strconv.Itoa(requested)+", above the hybrid.depth of "+strconv.Itoa(depth)+
			" that a hybrid query reranks from", map[string]any{"window": requested, "depth": depth})
	}
	return requested, nil
}

func nonBlankText(value string) (string, bool) {
	return value, strings.TrimSpace(value) != ""
}

func rerankQueryTextOf(params *model.QueryParams) (string, bool) {
	if query, set := params.Rerank.Query.Get(); set {
		return nonBlankText(query)
	}
	if term, present := nonBlankText(params.Term); present {
		return term, true
	}
	if params.Vector != nil {
		if text, set := params.Vector.Text.Get(); set {
			return nonBlankText(text)
		}
	}
	return "", false
}

func WithRerankQueryText(params model.QueryParams) model.QueryParams {
	if params.Rerank == nil || params.Rerank.Query.IsSet() {
		return params
	}
	query, present := rerankQueryTextOf(&params)
	if !present {
		return params
	}
	rerank := *params.Rerank
	rerank.Query = model.Some(query)
	params.Rerank = &rerank
	return params
}

func (ix *Index) resolveRerankPlan(params *model.QueryParams, maxWindow int, hybridDepth model.Optional[int]) (rerankPlan, error) {
	if len(params.Sort) > 0 {
		return rerankPlan{}, narsilerr.New(narsilerr.CodeSearchInvalidMode,
			"A query cannot carry both rerank and a sort, because each of them sets the order of the hits", map[string]any{})
	}
	rerank := params.Rerank
	if rerank.Adapter == "" {
		return rerankPlan{}, rerankInvalid("rerank.adapter must give the name of a registered rerank adapter", nil)
	}
	fields, err := ix.requireRerankTextFields(rerank.Fields)
	if err != nil {
		return rerankPlan{}, err
	}
	window, err := requireRerankWindow(rerank.Window, maxWindow, hybridDepth)
	if err != nil {
		return rerankPlan{}, err
	}
	query, present := rerankQueryTextOf(params)
	if !present {
		return rerankPlan{}, rerankInvalid("A reranked query needs text to compare each hit with: set rerank.query, term, or vector.text", nil)
	}
	return rerankPlan{adapter: rerank.Adapter, fields: fields, query: query, window: window}, nil
}

func rerankTextOf(values []any) string {
	lines := make([]string, 0, len(values))
	for _, value := range values {
		switch held := value.(type) {
		case string:
			lines = append(lines, held)
		case []string:
			lines = append(lines, held...)
		case []any:
			for _, member := range held {
				if text, isText := member.(string); isText {
					lines = append(lines, text)
				}
			}
		}
	}
	return strings.Join(lines, "\n")
}

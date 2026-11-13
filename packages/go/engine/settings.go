package engine

import (
	"context"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

func storedBM25(params model.BM25Params) model.BM25Params {
	stored := model.BM25Params{K1: params.K1, B: params.B}
	for name, pair := range params.Fields {
		if !pair.K1.IsSet() && !pair.B.IsSet() {
			continue
		}
		if stored.Fields == nil {
			stored.Fields = map[string]model.BM25FieldParams{}
		}
		stored.Fields[name] = pair
	}
	return stored
}

func indexBM25Of(params model.BM25Params) *model.BM25Params {
	if !bm25IsSet(params) {
		return nil
	}
	return &params
}

func replaceSettings(ctx context.Context, entry *indexEntry, change func(config *model.IndexConfig)) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	built := entry.index()
	previousLookup, previousBM25 := built.Synonyms(), built.BM25()
	entry.settingsMu.Lock()
	previous := entry.config
	change(&entry.config)
	entry.settingsMu.Unlock()
	if entry.durable == nil {
		return nil
	}
	err := entry.durable.PersistMetadata(ctx)
	if err == nil {
		return nil
	}
	entry.settingsMu.Lock()
	entry.config.BM25 = previous.BM25
	entry.config.Synonyms = previous.Synonyms
	entry.settingsMu.Unlock()
	built.SetSynonyms(previousLookup)
	built.SetBM25(previousBM25)
	return err
}

// UpdateBM25 replaces the k1 and b values that keyword ranking uses for the
// index called indexName, and the next query ranks with them. The engine
// checks every value as CreateIndex does and returns CONFIG_INVALID for a value
// outside its range or for a field that the schema does not declare as text.
// With durability configured, the engine writes the index metadata that holds
// the new values before it returns.
func (n *Narsil) UpdateBM25(ctx context.Context, indexName string, bm25 BM25Params) error {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return err
	}
	defer release()
	if err := validateCreateBM25(bm25, entry.parsed); err != nil {
		return err
	}
	stored := storedBM25(bm25)
	entry.lockWrites()
	defer entry.writeMu.Unlock()
	return replaceSettings(ctx, entry, func(config *model.IndexConfig) {
		config.BM25 = stored
		entry.index().SetBM25(indexBM25Of(stored))
	})
}

// UpdateSynonyms replaces the whole synonym set of the index called indexName,
// and the next query expands its terms with the new rules. An empty list
// removes every rule. The engine analyses each word with the index's analyser
// and returns CONFIG_INVALID for a malformed rule or for a word that analysis
// reduces to nothing. With durability configured, the engine writes the index
// metadata that holds the new rules before it returns.
func (n *Narsil) UpdateSynonyms(ctx context.Context, indexName string, rules []SynonymRule) error {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return err
	}
	defer release()
	lookup, canonical, err := entry.prepareSynonymRules(rules)
	if err != nil {
		return err
	}
	entry.lockWrites()
	defer entry.writeMu.Unlock()
	return replaceSettings(ctx, entry, func(config *model.IndexConfig) {
		config.Synonyms = canonical
		entry.index().SetSynonyms(entry.synonymsUnderHeldSettings(lookup, canonical))
	})
}

// GetSynonyms returns the synonym rules of the index called indexName in the
// form the engine stores them, or an empty list when the index has none.
func (n *Narsil) GetSynonyms(ctx context.Context, indexName string) ([]SynonymRule, error) {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return nil, err
	}
	defer release()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	rules := entry.currentConfig().Synonyms
	if rules == nil {
		return []SynonymRule{}, nil
	}
	return slices.Clone(rules), nil
}

package engine

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf16"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/indexconfig"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

var indexNamePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`)

func utf16Length(value string) int {
	return len(utf16.Encode([]rune(value)))
}

func validateIndexName(name string) error {
	if name == "" {
		return narsilerr.New(narsilerr.CodeConfigInvalid, "Index name must be a string of at least one character",
			map[string]any{"received": "string"})
	}
	if length := utf16Length(name); length > maxIndexNameLength {
		return narsilerr.New(narsilerr.CodeConfigInvalid, fmt.Sprintf("Index name must not exceed %d characters", maxIndexNameLength),
			map[string]any{"indexName": name, "length": length})
	}
	if !indexNamePattern.MatchString(name) {
		return narsilerr.New(narsilerr.CodeConfigInvalid,
			`Index name "`+name+`" contains invalid characters; use alphanumeric, dots, hyphens, and underscores only`,
			map[string]any{"indexName": name})
	}
	if strings.Contains(name, "..") {
		return narsilerr.New(narsilerr.CodeConfigInvalid, `Index name "`+name+`" must not contain ".."`,
			map[string]any{"indexName": name})
	}
	return nil
}

func leadingUTF16(value string, limit int) string {
	units := utf16.Encode([]rune(value))
	if len(units) <= limit {
		return value
	}
	return string(utf16.Decode(units[:limit]))
}

func requireBM25Value(label string, value model.Optional[float64], maximum float64) error {
	held, set := value.Get()
	if !set || (held >= 0 && held <= maximum) {
		return nil
	}
	return narsilerr.New(narsilerr.CodeConfigInvalid,
		fmt.Sprintf("%s must be a finite number from 0 to %s, and this request sets %s", label, text.FormatNumber(maximum), text.FormatNumber(held)),
		map[string]any{"parameter": label})
}

func validateCreateBM25(params model.BM25Params, parsed *schema.Parsed) error {
	if err := requireBM25Value("bm25.k1", params.K1, maxBM25K1); err != nil {
		return err
	}
	if err := requireBM25Value("bm25.b", params.B, maxBM25B); err != nil {
		return err
	}
	for _, name := range sortedNames(params.Fields) {
		shown := leadingUTF16(name, bm25DisplayedNameLength)
		field, declared := parsed.Field(name)
		if !declared {
			return narsilerr.New(narsilerr.CodeConfigInvalid,
				`BM25 parameters apply to a text field that the schema declares, and the schema declares no field "`+shown+`"`,
				map[string]any{"field": shown})
		}
		if !field.IsWordIndexed() {
			return narsilerr.New(narsilerr.CodeConfigInvalid,
				`BM25 parameters apply to a text field alone, and the schema declares field "`+shown+`" as "`+
					leadingUTF16(string(field.Type), bm25DisplayedNameLength)+`"`,
				map[string]any{"field": shown})
		}
		label := "bm25.fields." + shown
		pair := params.Fields[name]
		if err := requireBM25Value(label+".k1", pair.K1, maxBM25K1); err != nil {
			return err
		}
		if err := requireBM25Value(label+".b", pair.B, maxBM25B); err != nil {
			return err
		}
	}
	return nil
}

func (n *Narsil) filesystemDurability() bool {
	return n.manager != nil && n.tier == model.DurabilityWAL
}

func (n *Narsil) validateIndexConfig(name string, config model.IndexConfig, parsed *schema.Parsed) error {
	if err := schema.ValidatePatternValueLimit(config.PatternValueLimit); err != nil {
		return err
	}
	if err := schema.RequireSurfaceFormsForPartialFields(parsed, config.SurfaceForms); err != nil {
		return err
	}
	if err := schema.ValidateVectorPromotion(config.VectorPromotion); err != nil {
		return err
	}
	if err := schema.ValidateVectorStorage(config.VectorPromotion, n.filesystemDurability()); err != nil {
		return err
	}
	if err := schema.ValidateTextStorage(config.TextStorage, n.filesystemDurability()); err != nil {
		return err
	}
	if err := validateCreateBM25(config.BM25, parsed); err != nil {
		return err
	}
	if err := schema.ValidatePartitionConfig(config.Partitions); err != nil {
		return err
	}
	if n.manager == nil {
		return nil
	}
	if _, custom := config.Tokenizer.Custom(); custom {
		return narsilerr.New(narsilerr.CodeConfigInvalid,
			`Index "`+name+`" cannot use a tokenizer instance while durability is configured, because a checkpoint persists no code. Register it with RegisterTokenizer and pass its name`,
			map[string]any{"indexName": name})
	}
	if _, function := config.StopWords.Function(); function {
		return narsilerr.New(narsilerr.CodeConfigInvalid,
			`Index "`+name+`" cannot use a stop word function while durability is configured, because a checkpoint persists no code. Register it with RegisterStopWords and pass its name`,
			map[string]any{"indexName": name})
	}
	return nil
}

func (n *Narsil) resolveEmbedding(config model.IndexConfig, parsed *schema.Parsed, required bool) (model.EmbeddingAdapter, string, error) {
	if config.Embedding == nil {
		return nil, "", nil
	}
	fields := config.Embedding.Fields
	if name, named := config.Embedding.Adapter.RegisteredName(); named {
		registered, found := n.adapters.embedder(name)
		if found {
			if _, err := schema.ValidateEmbeddingConfig(fields, guardedEmbedder(registered), nil, parsed); err != nil {
				return nil, name, err
			}
			return registered, name, nil
		}
		if required {
			return nil, name, narsilerr.New(narsilerr.CodeEmbeddingConfigInvalid,
				fmt.Sprintf("Embedding adapter %q is not registered on this engine", name),
				map[string]any{"adapter": name, "available": n.adapters.embedderNames()})
		}
		return nil, name, nil
	}
	instance, _ := config.Embedding.Adapter.Instance()
	if !required && instance == nil && n.adapters.fallback == nil {
		return nil, "", nil
	}
	resolved, err := schema.ValidateEmbeddingConfig(fields, guardedEmbedder(instance), guardedEmbedder(n.adapters.fallback), parsed)
	if err != nil {
		return nil, "", err
	}
	if safe, wrapped := resolved.(safeEmbedder); wrapped {
		return safe.adapter, "", nil
	}
	return resolved, "", nil
}

func partitionCountOf(config model.IndexConfig) int {
	return config.Partitions.MaxPartitions.Or(schema.DefaultMaxPartitions)
}

// CreateIndex adds an empty index called name, built from config, and
// returns once the index takes writes and, with durability configured, once
// its settings are saved. It returns CodeIndexAlreadyExists for a name in
// use, CodeConfigInvalid for an invalid name or setting, a schema code for
// an invalid schema, CodeLanguageNotSupported for an unknown language, and
// CodeEmbeddingConfigInvalid when the embedding configuration names an
// adapter that the engine has not registered.
func (n *Narsil) CreateIndex(ctx context.Context, name string, config IndexConfig) error {
	return n.createIndex(ctx, name, config, nil)
}

func (n *Narsil) createIndex(ctx context.Context, name string, config IndexConfig, schemaOrder []string) error {
	leave, err := n.enter()
	if err != nil {
		return err
	}
	defer leave()
	if err := validateIndexName(name); err != nil {
		return err
	}
	unlock := n.names.lock(name)
	defer unlock()
	if n.known(name) {
		return narsilerr.New(narsilerr.CodeIndexAlreadyExists, `Index "`+name+`" already exists`, map[string]any{"indexName": name})
	}
	entry, err := n.prepareEntry(name, config, true, schemaOrder)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		entry.dispose()
		return err
	}
	if err := n.beforeSuggestionsCreate(ctx, entry); err != nil {
		entry.dispose()
		return err
	}
	if n.manager != nil {
		durable, err := n.manager.Create(ctx, entry.handle)
		if err != nil {
			entry.dispose()
			return err
		}
		entry.durable = durable
	}
	n.install(entry)
	n.enforceOpenLimits(ctx, name)
	return n.plugins.index(ctx, hookOnIndexCreate, &model.IndexContext{IndexName: name, Config: entry.currentConfig()})
}

func (n *Narsil) prepareEntry(name string, config model.IndexConfig, creating bool, schemaOrder []string) (
	*indexEntry, error) {
	parsed, err := schema.Parse(config.Schema)
	if err != nil {
		return nil, err
	}
	parsed = parsed.InFieldOrder(schemaOrder)
	if creating {
		if err := parsed.RequireCreatable(); err != nil {
			return nil, err
		}
	}
	if err := n.validateIndexConfig(name, config, parsed); err != nil {
		return nil, err
	}
	embedder, embeddingName, err := n.resolveEmbedding(config, parsed, creating)
	if err != nil {
		return nil, err
	}
	if len(config.Required) > 0 {
		if err := schema.ValidateRequiredFieldsInSchema(config.Required, parsed); err != nil {
			return nil, err
		}
	}
	if config.Language == "" {
		config.Language = defaultLanguage
	}
	entry, err := n.buildEntry(buildRequest{name: name, config: config, parsed: parsed, partitions: partitionCountOf(config),
		strictWords: creating, embedder: embedder, embeddingName: embeddingName})
	if err != nil {
		return nil, err
	}
	if creating {
		if _, err := indexconfig.Encode(entry.configurationFields()); err != nil {
			entry.dispose()
			return nil, err
		}
	}
	return entry, nil
}

package engine

import (
	"context"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/metadata"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

func lifecycleLimitInvalid(name string, value int64, allowZero bool) error {
	requirement := "a positive safe integer"
	if allowZero {
		requirement = "a non-negative safe integer"
	}
	return narsilerr.New(narsilerr.CodeConfigInvalid, name+" must be "+requirement, map[string]any{"field": name, "value": value})
}

func wholeMilliseconds(duration time.Duration) bool {
	return duration >= time.Millisecond && duration%time.Millisecond == 0
}

func validateLifecycleConfig(config *model.IndexLifecycleConfig, workers model.WorkerConfig) error {
	workerTimeout, workerTimeoutSet := workers.IdleTimeout.Get()
	if workerTimeoutSet && !wholeMilliseconds(workerTimeout) {
		return lifecycleLimitInvalid("workers.idleTimeoutMs", workerTimeout.Milliseconds(), false)
	}
	if config == nil {
		return nil
	}
	closeAfter, closeAfterSet := config.IdleTimeout.Get()
	if workerTimeoutSet && closeAfterSet && workerTimeout > closeAfter {
		return narsilerr.New(narsilerr.CodeConfigInvalid,
			"workers.idleTimeoutMs must be at most lifecycle.idleTimeoutMs, so that an index drops its copies before it closes",
			map[string]any{"workersIdleTimeoutMs": workerTimeout.Milliseconds(), "lifecycleIdleTimeoutMs": closeAfter.Milliseconds()})
	}
	if closeAfterSet && !wholeMilliseconds(closeAfter) {
		return lifecycleLimitInvalid("lifecycle.idleTimeoutMs", closeAfter.Milliseconds(), false)
	}
	if limit, set := config.MaxOpenIndexes.Get(); set && limit < 1 {
		return lifecycleLimitInvalid("lifecycle.maxOpenIndexes", int64(limit), false)
	}
	if limit, set := config.MaxOpenBytes.Get(); set && limit < 1 {
		return lifecycleLimitInvalid("lifecycle.maxOpenBytes", limit, false)
	}
	if limit, set := config.MaxReopenWaiters.Get(); set && limit < 0 {
		return lifecycleLimitInvalid("lifecycle.maxReopenWaiters", int64(limit), true)
	}
	return nil
}

func (n *Narsil) closedSummaryOf(meta metadata.Metadata) (closedSummary, error) {
	stored := storedFromMetadata(meta)
	config := stored.config
	language := config.Language
	if language == "" {
		language = defaultLanguage
	}
	found, known := core.LanguageLookup(language)
	if !known {
		return closedSummary{}, narsilerr.New(narsilerr.CodeLanguageNotSupported, `Language "`+language+`" is not supported`,
			map[string]any{"language": language})
	}
	parsed, err := schema.Parse(config.Schema)
	if err != nil {
		return closedSummary{}, err
	}
	if err := schema.ValidatePatternValueLimit(config.PatternValueLimit); err != nil {
		return closedSummary{}, err
	}
	if err := schema.RequireSurfaceFormsForPartialFields(parsed, config.SurfaceForms); err != nil {
		return closedSummary{}, err
	}
	if _, _, err := n.resolveEmbedding(config, parsed, false); err != nil {
		return closedSummary{}, err
	}
	if err := schema.ValidateVectorStorage(config.VectorPromotion, n.filesystemDurability()); err != nil {
		return closedSummary{}, err
	}
	if err := schema.ValidateTextStorage(config.TextStorage, n.filesystemDurability()); err != nil {
		return closedSummary{}, err
	}
	partitions := stored.partitions
	if partitions <= 0 {
		partitions = partitionCountOf(config)
	}
	return closedSummary{
		documentCount:  int(meta.DocumentCount.Or(0)),
		partitionCount: partitions,
		language:       core.LanguageName(found),
		schema:         parsed.Schema(),
		config:         config,
		suggestions:    meta.QuerySuggestions,
	}, nil
}

func (n *Narsil) registerClosedIndexes(ctx context.Context) error {
	described, err := n.manager.RecoverMetadata(ctx)
	if err != nil {
		return err
	}
	summaries := make(map[string]closedSummary, len(described))
	for _, meta := range described {
		summary, err := n.closedSummaryOf(meta)
		if err != nil {
			return err
		}
		summaries[meta.IndexName] = summary
	}
	for name, summary := range summaries {
		n.registerClosed(name, summary)
	}
	return nil
}

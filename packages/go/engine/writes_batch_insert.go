package engine

import (
	"context"

	"github.com/assetcorp/narsil/packages/go/engine/internal/callerctx"
	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/memory"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

type pendingInsert struct {
	id      string
	context *model.InsertContext
	write   persist.Write
}

type hookedInserts struct {
	contexts  []*model.InsertContext
	working   []*model.Document
	live      []bool
	refusals  []error
	refusedAs []string
}

func newHookedInserts(size int) hookedInserts {
	return hookedInserts{contexts: make([]*model.InsertContext, size), working: make([]*model.Document, size),
		live: make([]bool, size), refusals: make([]error, size), refusedAs: make([]string, size)}
}

func (hooked hookedInserts) refuse(at int, id string, err error) {
	hooked.live[at] = false
	hooked.refusals[at] = err
	hooked.refusedAs[at] = id
}

func (n *Narsil) runBeforeInsertHooks(ctx context.Context, indexName string, documents []*model.Document,
	hooked hookedInserts) {
	for at := range documents {
		document := codec.SnapshotDocument(documents[at])
		reported, _ := schema.ProvidedDocID(document)
		if err := requireDocument(document); err != nil {
			hooked.refuse(at, reported, err)
			continue
		}
		id, err := n.resolveInsertID(document, "")
		if err != nil {
			hooked.refuse(at, reported, err)
			continue
		}
		hooked.contexts[at] = &model.InsertContext{IndexName: indexName, DocID: id, Document: document}
		if err := n.plugins.insert(ctx, hookBeforeInsert, hooked.contexts[at]); err != nil {
			hooked.refuse(at, id, err)
			continue
		}
		hooked.working[at] = hooked.contexts[at].Document
		if err := requireDocument(hooked.working[at]); err != nil {
			hooked.refuse(at, id, err)
			continue
		}
		hooked.live[at] = true
	}
}

func (hooked hookedInserts) admitInto(entry *indexEntry) {
	for at := range hooked.working {
		if !hooked.live[at] || len(entry.config.Required) == 0 {
			continue
		}
		if err := schema.ValidateRequiredFields(hooked.working[at], entry.config.Required); err != nil {
			hooked.refuse(at, hooked.contexts[at].DocID, err)
		}
	}
}

// InsertBatch adds documents to the index called indexName in chunks of
// 1,000 and reports each one: the IDs that the engine wrote, and each
// refused document with its error. One refused document never stops the
// rest, and a nil entry is refused with CodeDocValidationFailed. The engine
// reads each document once, as Insert does. The returned error is set only
// when the whole call fails, such as for an unknown index, a cancelled
// context, or a durable write that failed.
func (n *Narsil) InsertBatch(ctx context.Context, indexName string, documents []*Document, options InsertOptions) (BatchResult, error) {
	ctx = callerctx.Shield(ctx)
	entry, release, err := n.acquireContext(ctx, indexName)
	if err != nil {
		return model.BatchResult{}, err
	}
	defer n.emitWrite(indexName)
	var notifications []model.Event
	defer func() { n.events.emitAll(notifications) }()
	defer func() { release() }()
	if err := n.memory.refuseWhileFull(indexName); err != nil {
		return model.BatchResult{}, err
	}
	outcome := newBatchOutcome()
	defer func() {
		if entry != nil {
			entry.scheduleVectorBuilds(outcome.touched)
		}
	}()
	entry, release, err = n.insertInGroups(ctx, n.holderOf(indexName), entry, release, documents, outcome)
	if err != nil {
		return outcome.result, err
	}
	notifications = n.afterWriteOn(entry, indexName)
	return outcome.result, nil
}

func (n *Narsil) insertChunk(ctx context.Context, holder indexHolder, entry *indexEntry, release func(),
	documents []*model.Document, outcome *batchOutcome) (*indexEntry, func(), error) {
	hooked := newHookedInserts(len(documents))
	if entry != nil && n.plugins.hasHook(hookBeforeInsert) {
		release()
		entry, release = nil, releasedNothing
	}
	n.runBeforeInsertHooks(ctx, holder.name, documents, hooked)
	if entry == nil {
		var err error
		if entry, release, err = holder.reacquire(); err != nil {
			return nil, releasedNothing, err
		}
	}
	hooked.admitInto(entry)
	entry, release, err := n.embedChunk(ctx, entry, release,
		chunkEmbedding{working: hooked.working, live: hooked.live, contexts: hooked.contexts, refuse: hooked.refuse})
	if err != nil {
		return entry, release, err
	}
	entry, release, inserted, err := n.insertPreparedGroups(ctx, holder, entry, release, hooked, outcome)
	if err != nil || len(inserted) == 0 || !n.plugins.hasHook(hookAfterInsert) {
		return entry, release, err
	}
	scheduleTouched(entry, outcome.touched)
	release()
	for _, insert := range inserted {
		_ = n.plugins.insert(ctx, hookAfterInsert, insert)
	}
	return nil, releasedNothing, nil
}

type refusedInsert struct {
	id  string
	err error
}

func (n *Narsil) applyInsertChunk(ctx context.Context, entry *indexEntry, release func(), pending []pendingInsert,
	outcome *batchOutcome) (*indexEntry, func(), []*model.InsertContext, error) {
	if len(pending) == 0 {
		return entry, release, nil, nil
	}
	candidates := make([]persist.Write, len(pending))
	ids := make([]string, len(pending))
	for at, insert := range pending {
		candidates[at] = insert.write
		ids[at] = insert.id
	}
	var accepted []pendingInsert
	var refused []refusedInsert
	var failures []error
	var burst *memory.Reservation
	entry, release, err := n.applyKeepingTokens(ctx, entry.name, entry, release, index.WriteInsert, candidates,
		func(ctx context.Context, entry *indexEntry) (persist.Commit, error) {
			var commit persist.Commit
			var err error
			if burst, err = n.memory.reserveWriteBurst(entry, ids); err != nil {
				return commit, err
			}
			accepted, refused, err = acceptedInserts(ctx, entry, pending)
			if err != nil {
				return commit, err
			}
			writes := make([]persist.Write, len(accepted))
			for at, insert := range accepted {
				writes[at] = insert.write
			}
			failures, commit, err = entry.apply(ctx, writes, index.WriteInsert)
			return commit, err
		})
	if burst != nil {
		burst.Release()
	}
	for _, insert := range refused {
		outcome.fail(insert.id, insert.err)
	}
	if err != nil && (!cancelledBatch(err) || len(failures) != len(accepted)) {
		for _, insert := range accepted {
			outcome.fail(insert.id, err)
		}
		return entry, release, nil, err
	}
	inserted := make([]*model.InsertContext, 0, len(accepted))
	for at, insert := range accepted {
		if failures[at] != nil {
			outcome.fail(insert.id, failures[at])
			continue
		}
		outcome.result.Succeeded = append(outcome.result.Succeeded, insert.id)
		outcome.touched.note(insert.write)
		inserted = append(inserted, insert.context)
	}
	return entry, release, inserted, err
}

func acceptedInserts(ctx context.Context, entry *indexEntry, pending []pendingInsert) ([]pendingInsert,
	[]refusedInsert, error) {
	ids := make([]string, len(pending))
	for at, insert := range pending {
		ids[at] = insert.id
	}
	present, err := entry.presence(ctx, ids)
	if err != nil {
		return nil, nil, err
	}
	accepted := make([]pendingInsert, 0, len(pending))
	var refused []refusedInsert
	seen := make(map[string]struct{}, len(pending))
	for at, insert := range pending {
		if _, repeated := seen[insert.id]; repeated || present[at] {
			refused = append(refused, refusedInsert{id: insert.id, err: entry.alreadyExists(insert.id)})
			continue
		}
		if err := entry.capacityError(len(accepted)); err != nil {
			refused = append(refused, refusedInsert{id: insert.id, err: err})
			continue
		}
		seen[insert.id] = struct{}{}
		accepted = append(accepted, insert)
	}
	return accepted, refused, nil
}

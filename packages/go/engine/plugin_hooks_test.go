package engine_test

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	pluginHooksIndex       = "audited"
	pluginStampKey         = "stamped"
	pluginInsertStamp      = "on insert"
	pluginUpdateStamp      = "on update"
	pluginRefusedKey       = "refused"
	pluginFirstTitle       = "red kettle"
	pluginSecondTitle      = "blue kettle"
	pluginAuditedDocument  = "d1"
	pluginRefusedDocument  = "d2"
	pluginRefusalStatement = "the audit plugin refuses this document"
)

type hookAudit struct {
	calls         []string
	replacedTitle any
}

func (audit *hookAudit) plugin() engine.Plugin {
	return engine.Plugin{
		Name: "audit",
		BeforeInsert: func(_ context.Context, insert *engine.InsertContext) error {
			audit.calls = append(audit.calls, "beforeInsert")
			if _, refused := insert.Document.Get(pluginRefusedKey); refused {
				return errors.New(pluginRefusalStatement)
			}
			insert.Document.Set(pluginStampKey, pluginInsertStamp)
			return nil
		},
		AfterInsert: func(_ context.Context, _ *engine.InsertContext) error {
			audit.calls = append(audit.calls, "afterInsert")
			return nil
		},
		BeforeUpdate: func(_ context.Context, update *engine.UpdateContext) error {
			audit.calls = append(audit.calls, "beforeUpdate")
			audit.replacedTitle, _ = update.OldDocument.Get("title")
			update.NewDocument.Set(pluginStampKey, pluginUpdateStamp)
			return nil
		},
		AfterUpdate: func(_ context.Context, _ *engine.UpdateContext) error {
			audit.calls = append(audit.calls, "afterUpdate")
			return nil
		},
		BeforeRemove: func(_ context.Context, _ *engine.RemoveContext) error {
			audit.calls = append(audit.calls, "beforeRemove")
			return nil
		},
		AfterRemove: func(_ context.Context, _ *engine.RemoveContext) error {
			audit.calls = append(audit.calls, "afterRemove")
			return nil
		},
		BeforeSearch: func(_ context.Context, _ *engine.SearchContext) error {
			audit.calls = append(audit.calls, "beforeSearch")
			return nil
		},
		AfterSearch: func(_ context.Context, _ *engine.SearchContext) error {
			audit.calls = append(audit.calls, "afterSearch")
			return nil
		},
		OnIndexCreate: func(_ context.Context, _ *engine.IndexContext) error {
			audit.calls = append(audit.calls, "onIndexCreate")
			return nil
		},
		OnIndexDrop: func(_ context.Context, _ *engine.IndexContext) error {
			audit.calls = append(audit.calls, "onIndexDrop")
			return nil
		},
	}
}

func requireLastKey(t *testing.T, narsil *engine.Narsil, id, key string, value any) {
	t.Helper()
	stored, found, err := narsil.Get(context.Background(), pluginHooksIndex, id)
	if err != nil || !found {
		t.Fatalf("the engine failed to read document %q (found %t) with %s: %v", id, found, codeOrMessage(err), err)
	}
	var lastKey string
	var lastValue any
	for storedKey, storedValue := range stored.All() {
		lastKey, lastValue = storedKey, storedValue
	}
	if lastKey != key || lastValue != value {
		t.Fatalf("document %q ends with %q = %v, while the plugin added %q = %v after the other keys", id, lastKey, lastValue, key, value)
	}
}

func TestPluginHooksRunAroundEveryOperationAndRefuseWrites(t *testing.T) {
	ctx := context.Background()
	audit := &hookAudit{}
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Plugins: []engine.Plugin{audit.plugin()}})
	if err != nil {
		t.Fatalf("the engine refused to start: %v", err)
	}
	t.Cleanup(func() { _ = narsil.Shutdown(context.Background()) })
	if err := narsil.CreateIndex(ctx, pluginHooksIndex, engine.IndexConfig{Schema: engine.Schema{"title": engine.FieldString},
		Language: "english"}); err != nil {
		t.Fatalf("the engine refused the index with %s: %v", codeOrMessage(err), err)
	}
	written := engine.NewDocument().Set("title", pluginFirstTitle)
	if _, err := narsil.Insert(ctx, pluginHooksIndex, written, pluginAuditedDocument, engine.InsertOptions{}); err != nil {
		t.Fatalf("the engine refused the document with %s: %v", codeOrMessage(err), err)
	}
	if _, stamped := written.Get(pluginStampKey); stamped {
		t.Fatalf("the plugin changed the caller's document, while it receives the engine's copy")
	}
	requireLastKey(t, narsil, pluginAuditedDocument, pluginStampKey, pluginInsertStamp)
	refused := engine.NewDocument().Set("title", pluginFirstTitle).Set(pluginRefusedKey, true)
	_, err = narsil.Insert(ctx, pluginHooksIndex, refused, pluginRefusedDocument, engine.InsertOptions{})
	if engine.ErrorCode(err) != engine.CodeDocValidationFailed {
		t.Fatalf("the refused insert returned %s, while a refusing plugin returns %s", codeOrMessage(err), engine.CodeDocValidationFailed)
	}
	if held, err := narsil.Has(ctx, pluginHooksIndex, pluginRefusedDocument); err != nil || held {
		t.Fatalf("the index holds the refused document (held %t) with %s: %v", held, codeOrMessage(err), err)
	}
	replacement := engine.NewDocument().Set("title", pluginSecondTitle)
	if err := narsil.Update(ctx, pluginHooksIndex, pluginAuditedDocument, replacement, engine.WriteOptions{}); err != nil {
		t.Fatalf("the engine refused the update with %s: %v", codeOrMessage(err), err)
	}
	if audit.replacedTitle != pluginFirstTitle {
		t.Fatalf("the update hook saw the old title %v, while the index held %q", audit.replacedTitle, pluginFirstTitle)
	}
	requireLastKey(t, narsil, pluginAuditedDocument, pluginStampKey, pluginUpdateStamp)
	result, err := narsil.Query(ctx, pluginHooksIndex, engine.QueryParams{Term: "blue"})
	if err != nil || len(result.Hits) != 1 {
		t.Fatalf("the query returned %d hits with %s: %v", len(result.Hits), codeOrMessage(err), err)
	}
	if err := narsil.Remove(ctx, pluginHooksIndex, pluginAuditedDocument, engine.WriteOptions{}); err != nil {
		t.Fatalf("the engine refused the removal with %s: %v", codeOrMessage(err), err)
	}
	if err := narsil.DropIndex(ctx, pluginHooksIndex); err != nil {
		t.Fatalf("the engine refused to drop the index with %s: %v", codeOrMessage(err), err)
	}
	expected := []string{"onIndexCreate", "beforeInsert", "afterInsert", "beforeInsert", "beforeUpdate", "afterUpdate",
		"beforeSearch", "afterSearch", "beforeRemove", "afterRemove", "onIndexDrop"}
	if !reflect.DeepEqual(audit.calls, expected) {
		t.Fatalf("the hooks ran as %v, while the operations call for %v", audit.calls, expected)
	}
}

package engine_test

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"runtime/debug"
	"strings"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

func memoryAttackChild(t *testing.T, limit int) bool {
	t.Helper()
	const variable = "NARSIL_MEMORY_ATTACK_CHILD"
	if os.Getenv(variable) == t.Name() {
		return true
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), memoryChildDeadline)
	defer cancel()
	child := exec.CommandContext(ctx, executable, "-test.run=^"+regexp.QuoteMeta(t.Name())+"$", "-test.v")
	child.Env = append(os.Environ(), variable+"="+t.Name(), fmt.Sprintf("GOMEMLIMIT=%d", limit))
	if output, err := child.CombinedOutput(); err != nil {
		t.Fatalf("the memory attack failed: %v\n%s", err, output)
	}
	return false
}

func TestMemoryBlockChecksTheDocumentAfterWriteHooks(t *testing.T) {
	if !memoryAttackChild(t, 64<<20) {
		return
	}
	for _, kind := range []string{"insert", "update", "insert batch", "update batch"} {
		t.Run(kind, func(t *testing.T) {
			defer debug.FreeOSMemory()
			ctx := context.Background()
			var narsil *engine.Narsil
			armed := false
			grow := func(id string, document *engine.Document) error {
				if !armed || id != "refused" {
					return nil
				}
				if _, err := narsil.CountDocuments(ctx, memoryIndexName); err != nil {
					return err
				}
				document.Set("payload", strings.Repeat("x", 5<<20))
				return nil
			}
			plugin := engine.Plugin{Name: "enrich-document",
				BeforeInsert: func(_ context.Context, insert *engine.InsertContext) error {
					return grow(insert.DocID, insert.Document)
				},
				BeforeUpdate: func(_ context.Context, update *engine.UpdateContext) error {
					return grow(update.DocID, update.NewDocument)
				}}
			var err error
			narsil, err = engine.New(ctx, engine.Config{Plugins: []engine.Plugin{plugin},
				Workers: engine.WorkerConfig{Enabled: engine.Some(false)}})
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = narsil.Shutdown(ctx) }()
			if err := narsil.CreateIndex(ctx, memoryIndexName, engine.IndexConfig{Schema: engine.Schema{"title": engine.FieldString}}); err != nil {
				t.Fatal(err)
			}
			isUpdate := strings.HasPrefix(kind, "update")
			ids := []string{"kept", "refused", "later"}
			if isUpdate {
				for _, id := range ids {
					if _, err := narsil.Insert(ctx, memoryIndexName, identifiedNote(id, "original"), "", engine.InsertOptions{}); err != nil {
						t.Fatal(err)
					}
				}
			}
			armed = true
			var refusal error
			switch kind {
			case "insert":
				_, refusal = narsil.Insert(ctx, memoryIndexName, identifiedNote("refused", "changed"), "", engine.InsertOptions{})
			case "update":
				refusal = narsil.Update(ctx, memoryIndexName, "refused", identifiedNote("refused", "changed"), engine.WriteOptions{})
			default:
				var result engine.BatchResult
				if isUpdate {
					updates := make([]engine.DocumentUpdate, len(ids))
					for at, id := range ids {
						updates[at] = engine.DocumentUpdate{DocID: id, Document: identifiedNote(id, "changed")}
					}
					result, err = narsil.UpdateBatch(ctx, memoryIndexName, updates, engine.WriteOptions{})
				} else {
					documents := make([]*engine.Document, len(ids))
					for at, id := range ids {
						documents[at] = identifiedNote(id, "changed")
					}
					result, err = narsil.InsertBatch(ctx, memoryIndexName, documents, engine.InsertOptions{})
				}
				if err != nil || len(result.Succeeded) != 1 || result.Succeeded[0] != "kept" || len(result.Failed) != 2 {
					t.Fatalf("the batch must keep its prefix and refuse its suffix: %+v, %v", result, err)
				}
				refusal = result.Failed[0].Err
				later := result.Failed[1]
				if later.DocID != "later" || later.Err.Code != engine.CodeMemoryWriteBlocked || later.Err.Details["refusedDocId"] != "refused" {
					t.Fatalf("the suffix must identify the refused document: %+v", later)
				}
			}
			requireMemoryRefusal(t, refusalOf("refused", refusal), "refused", "write_exceeds_memory")
			stored, found, err := narsil.Get(ctx, memoryIndexName, "refused")
			if err != nil || found != isUpdate {
				t.Fatalf("the refusal changed whether the document exists: %v, %v", found, err)
			}
			if found {
				if title, _ := stored.Get("title"); title != "original" {
					t.Fatalf("the refused update changed the stored document: %v", title)
				}
			}
		})
	}
}

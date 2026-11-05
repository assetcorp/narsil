package narsil_test

import (
	"fmt"
	"testing"

	narsil "github.com/assetcorp/narsil/packages/go"
)

func createTitleIndex(t *testing.T, client *narsil.Client, name string) {
	t.Helper()
	ctx := testContext(t)
	if _, err := client.CreateIndex(ctx, narsil.HTTPCreateIndexBody{
		Name: name, Config: narsil.HTTPIndexBody{Schema: titleAndYearSchema()},
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = client.DropIndex(testContext(t), name) })
}

func TestDocumentThatBreaksTheSchemaRaisesTheServerCode(t *testing.T) {
	ctx := testContext(t)
	client := newClient(t, narsil.Config{URLs: []string{shared.plain.url}})
	name := indexName(t)
	createTitleIndex(t, client, name)
	_, err := client.Insert(ctx, name, narsil.InsertBody{Document: narsil.AnyDocument{"title": 42, "year": "late"}})
	requireCode(t, err, "DOC_VALIDATION_FAILED", 400)
	expectCount(t, client, name, 0)
}

func TestUnknownIndexRaisesIndexNotFound(t *testing.T) {
	client := newClient(t, narsil.Config{URLs: []string{shared.plain.url}})
	_, err := client.Query(testContext(t), "go_index_that_was_never_created", narsil.HTTPQueryParams{Term: narsil.Ptr("ridge")})
	requireCode(t, err, "INDEX_NOT_FOUND", 404)
}

func TestRefusedCredentialRaisesTheHookCodeAndTheRightKeyPasses(t *testing.T) {
	ctx := testContext(t)
	refused := newClient(t, narsil.Config{URLs: []string{shared.secured.url}, APIKey: "narsil-wrong-key"})
	_, err := refused.ListIndexes(ctx)
	requireCode(t, err, "UNAUTHORIZED", 401)
	accepted := newClient(t, narsil.Config{URLs: []string{shared.secured.url}, APIKey: securedAPIKey})
	if _, err := accepted.ListIndexes(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestImportOverTheServerLimitRaisesPayloadTooLarge(t *testing.T) {
	ctx := testContext(t)
	client := newClient(t, narsil.Config{URLs: []string{shared.secured.url}, APIKey: securedAPIKey})
	name := indexName(t)
	createTitleIndex(t, client, name)
	documents := make([]narsil.AnyDocument, 200)
	for number := range documents {
		documents[number] = narsil.AnyDocument{"title": fmt.Sprintf("Trail number %d along the ridge", number), "year": 2001}
	}
	_, err := client.ImportDocuments(ctx, name, documents)
	requireCode(t, err, "PAYLOAD_TOO_LARGE", 413)
	expectCount(t, client, name, 0)
	accepted, err := client.ImportDocuments(ctx, name, documents[:10])
	if err != nil || accepted.Indexed != 10 {
		t.Fatalf("a small import answered %+v with %v", accepted, err)
	}
}

func TestProxyThatAnswersHTMLRaisesInvalidResponse(t *testing.T) {
	client := newClient(t, narsil.Config{URLs: []string{proxyToNowhere(t)}})
	_, err := client.ListIndexes(testContext(t))
	requireCode(t, err, narsil.CodeClientInvalidResponse, 502)
}

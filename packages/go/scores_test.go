package narsil_test

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	narsil "github.com/assetcorp/narsil/packages/go"
)

func TestScoreTokensRoundTripOverHTTP(t *testing.T) {
	hits := `[{"id":"nan","score":"NaN","document":{"score":"NaN"}},` +
		`{"id":"positive","score":"Infinity","document":{"score":"Infinity"}},` +
		`{"id":"negative","score":"-Infinity","document":{"score":"-Infinity"}},` +
		`{"id":"zero","score":0,"document":{}},{"id":"absent","document":{}}]`
	replies := map[string]string{
		"/indexes/valid/search": `{"hits":` + hits + `,"groups":[{"values":{},"hits":` + hits + `}]}`,
	}
	invalid := []string{"null", "true", "false", "{}", "[]", `"nan"`, `"1"`, `"+Infinity"`, "1e999", "-1e999"}
	for index, score := range invalid {
		hit := `{"id":"product","document":{},"score":` + score + `}`
		body := `{"hits":[` + hit + `]}`
		if index%2 != 0 {
			body = `{"hits":[],"groups":[{"values":{},"hits":[` + hit + `]}]}`
		}
		replies[fmt.Sprintf("/indexes/invalid%d/search", index)] = body
	}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		fmt.Fprint(response, replies[request.URL.Path])
	}))
	t.Cleanup(server.Close)
	client := newClient(t, narsil.Config{URLs: []string{server.URL}})
	answer, err := client.Query(testContext(t), "valid", narsil.HTTPQueryParams{})
	if err != nil {
		t.Fatal(err)
	}
	if len(answer.Groups) != 1 {
		t.Fatalf("expected one group, got %d", len(answer.Groups))
	}
	for _, decoded := range [][]narsil.Hit{answer.Hits, answer.Groups[0].Hits} {
		if len(decoded) != 5 {
			t.Fatalf("expected five hits, got %d", len(decoded))
		}
		if decoded[0].Score == nil || !math.IsNaN(*decoded[0].Score) ||
			decoded[1].Score == nil || !math.IsInf(*decoded[1].Score, 1) ||
			decoded[2].Score == nil || !math.IsInf(*decoded[2].Score, -1) ||
			decoded[3].Score == nil || *decoded[3].Score != 0 || decoded[4].Score != nil {
			t.Fatalf("scores lost their numeric values: %+v", decoded)
		}
		encoded, err := json.Marshal(decoded)
		if err != nil {
			t.Fatal(err)
		}
		var wanted, received any
		if err := json.Unmarshal([]byte(hits), &wanted); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(encoded, &received); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(wanted, received) {
			t.Fatalf("score or document data changed: %s", encoded)
		}
	}
	for index := range invalid {
		_, err := client.Query(testContext(t), fmt.Sprintf("invalid%d", index), narsil.HTTPQueryParams{})
		requireCode(t, err, narsil.CodeClientInvalidResponse, 0)
	}
}

package narsil

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type exchange struct {
	method        string
	path          string
	query         url.Values
	contentType   string
	payload       []byte
	upload        io.Reader
	repeatable    bool
	carriesCorpus bool
}

type answered struct {
	status   int
	header   http.Header
	body     []byte
	url      string
	response *http.Response
	release  func()
	tryCtx   context.Context
	timeout  time.Duration
}

func (a *answered) text() string {
	return strings.ToValidUTF8(string(a.body), "�")
}

const unreservedInComponent = "-_.!~*'()"

func escapePathSegment(value string) string {
	var out strings.Builder
	for _, b := range []byte(value) {
		if ('a' <= b && b <= 'z') || ('A' <= b && b <= 'Z') || ('0' <= b && b <= '9') ||
			strings.IndexByte(unreservedInComponent, b) >= 0 {
			out.WriteByte(b)
			continue
		}
		fmt.Fprintf(&out, "%%%02X", b)
	}
	return out.String()
}

func joinQuery[T ~string](values []T) string {
	parts := make([]string, len(values))
	for position, value := range values {
		parts[position] = string(value)
	}
	return strings.Join(parts, ",")
}

func formatNumber(value float64) string {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return "NaN"
	}
	return strconv.FormatFloat(value, 'f', -1, 64)
}

func encodeJSON(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, fmt.Errorf("narsil: the client cannot encode the request body as JSON: %w", err)
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte("\n")), nil
}

func decodeAnswer[T any](answer *answered) (T, error) {
	var value T
	if err := json.Unmarshal(answer.body, &value); err != nil {
		return value, invalidResponse(
			fmt.Sprintf("The answer from %s does not hold the shape that the route documents: %v", answer.url, err),
			map[string]any{"url": answer.url, "status": answer.status},
		)
	}
	return value, nil
}

func decodePointer[T any](answer *answered) (*T, error) {
	value, err := decodeAnswer[T](answer)
	if err != nil {
		return nil, err
	}
	return &value, nil
}

func zeroOf[T any]() T {
	var zero T
	return zero
}

func undocumentedStatus(answer *answered) *Error {
	return invalidResponse(
		fmt.Sprintf("The server answered %s with HTTP %d, which the route does not document", answer.url, answer.status),
		map[string]any{"url": answer.url, "status": answer.status},
	)
}

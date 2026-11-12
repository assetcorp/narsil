package changes

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"

	narsil "github.com/assetcorp/narsil/packages/go"
	"github.com/coder/websocket"
)

// Subprotocol is the WebSocket subprotocol of the change feed.
const Subprotocol = "narsil.changes.v1"

// DefaultMaxMessageBytes is the longest feed message that a subscription reads unless
// Options.MaxMessageBytes says otherwise. It covers a batch of 1 MiB of changes with one update whose
// document and previous document each fill the server's default request body limit of 16 MiB.
const DefaultMaxMessageBytes = 48 << 20

const (
	maxSubscriberMessageBytes = 65_536
	closeReasonSubscriber     = "subscriber closed"
	tokenPunctuation          = "!#$%&'*+-.^_`|~"
)

// Options sets where a subscription starts, which changes it receives, and how it proves the caller's
// access.
type Options struct {
	// Epoch is the epoch that Positions belong to. Set both, or leave both unset to start at the index's
	// current heads.
	Epoch string
	// Positions holds one saved position for each partition.
	Positions []Position
	// Filter keeps only the changes whose document before or after the write matches it, in the syntax
	// of a query's filters. The index needs previousDocument on.
	Filter *narsil.FilterExpression
	// Credential is offered as a second WebSocket subprotocol after narsil.changes.v1, where the server's
	// onRequest hook reads it from the Sec-WebSocket-Protocol header. It must hold only the characters
	// of an HTTP token. The upgrade also carries Config.Headers and Config.APIKey of the client.
	Credential string
	// MaxMessageBytes is the longest feed message that the subscription reads, DefaultMaxMessageBytes
	// when zero. A longer message ends the subscription with CLIENT_INVALID_RESPONSE.
	MaxMessageBytes int64
}

// Subscription is one connection to the change feed of an index, which returns its events one at a
// time through Next or All.
//
// The server stops sending once the changes that the caller has not acknowledged pass the window in
// Subscribed.WindowBytes, so call Ack with each position once the caller has saved it. Next takes one
// goroutine at a time, while Ack and Close are safe from any goroutine, including from inside a loop
// over All.
type Subscription struct {
	conn       *websocket.Conn
	ctx        context.Context
	url        string
	redact     redactor
	stopCancel func() bool
	closing    atomic.Bool
	reading    sync.Mutex
	mutex      sync.Mutex
	state      *feedState
	saved      []uint64
	ended      bool
	failure    error
}

// Follow opens the change feed of an index on the next address of client and sends the subscription.
// ctx bounds the whole subscription: cancelling it closes the connection, and Next then returns
// CLIENT_REQUEST_ABORTED.
//
// It fails with CHANGES_INVALID_POSITIONS when only one of Epoch and Positions is set, with
// CONFIG_INVALID for a credential outside the characters of an HTTP token, and with the code of the
// server's error envelope, such as FORBIDDEN from an onRequest hook, when the server refuses the
// upgrade.
func Follow(ctx context.Context, client *narsil.Client, index string, options Options) (*Subscription, error) {
	subscribe, err := subscribeMessage(options)
	if err != nil {
		return nil, err
	}
	target, err := client.ChangeFeedTarget(index)
	if err != nil {
		return nil, err
	}
	protocols := []string{Subprotocol}
	if options.Credential != "" {
		protocols = append(protocols, options.Credential)
	}
	redact := redactor{credential: options.Credential}
	conn, response, err := websocket.Dial(ctx, target.URL, &websocket.DialOptions{
		HTTPClient: target.HTTPClient, HTTPHeader: target.Header, Subprotocols: protocols,
	})
	if err != nil {
		return nil, refusedUpgrade(ctx, redact, target.URL, response, err)
	}
	if conn.Subprotocol() != Subprotocol {
		_ = conn.CloseNow()
		return nil, narsil.NewError(narsil.CodeClientInvalidResponse,
			"The server answered the change feed with another subprotocol", map[string]any{"url": target.URL}, nil)
	}
	limit := options.MaxMessageBytes
	if limit == 0 {
		limit = DefaultMaxMessageBytes
	}
	conn.SetReadLimit(limit)
	if err := conn.Write(ctx, websocket.MessageBinary, subscribe); err != nil {
		_ = conn.CloseNow()
		return nil, redact.failure(ctx, target.URL, err)
	}
	subscription := &Subscription{conn: conn, ctx: ctx, url: target.URL, redact: redact}
	subscription.stopCancel = context.AfterFunc(ctx, func() { _ = conn.CloseNow() })
	return subscription, nil
}

func refusedUpgrade(ctx context.Context, redact redactor, url string, response *http.Response, err error) error {
	if ctx.Err() == nil && response != nil && response.StatusCode != http.StatusSwitchingProtocols && response.Body != nil {
		body, _ := io.ReadAll(response.Body)
		return narsil.ResponseError(response.StatusCode, body, url)
	}
	return redact.failure(ctx, url, err)
}

func subscribeMessage(options Options) ([]byte, error) {
	if (options.Epoch == "") != (options.Positions == nil) {
		return nil, narsil.NewError(codeChangesInvalidPositions, "Pass Epoch and Positions together, or leave both unset", nil, nil)
	}
	if options.MaxMessageBytes < 0 {
		return nil, configInvalid("Options.MaxMessageBytes takes 0 or more bytes")
	}
	if !isToken(options.Credential) {
		return nil, configInvalid("Options.Credential must hold only the characters of an HTTP token")
	}
	message := map[string]any{"type": "subscribe"}
	if options.Positions != nil {
		message["epoch"] = options.Epoch
		message["positions"] = positionList(options.Positions)
	}
	if options.Filter != nil {
		filter, err := filterValue(options.Filter)
		if err != nil {
			return nil, err
		}
		message["filter"] = filter
	}
	return boundedMessage(message)
}

func filterValue(filter *narsil.FilterExpression) (any, error) {
	encoded, err := json.Marshal(filter)
	if err != nil {
		return nil, configInvalid("Options.Filter cannot be encoded: " + err.Error())
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, configInvalid("Options.Filter cannot be encoded: " + err.Error())
	}
	return value, nil
}

func boundedMessage(message map[string]any) ([]byte, error) {
	encoded, err := encodeMessage(message)
	if err != nil {
		return nil, configInvalid("The subscriber message cannot be encoded: " + err.Error())
	}
	if len(encoded) > maxSubscriberMessageBytes {
		return nil, configInvalid("The subscriber message passes the server's limit of 65,536 bytes")
	}
	return encoded, nil
}

func positionList(positions []Position) []any {
	list := make([]any, len(positions))
	for at, position := range positions {
		list[at] = map[string]any{"partitionId": position.PartitionID, "seqNo": position.SeqNo}
	}
	return list
}

func isToken(value string) bool {
	for _, character := range []byte(value) {
		alphanumeric := ('a' <= character && character <= 'z') || ('A' <= character && character <= 'Z') ||
			('0' <= character && character <= '9')
		if !alphanumeric && strings.IndexByte(tokenPunctuation, character) < 0 {
			return false
		}
	}
	return true
}

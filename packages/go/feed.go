package narsil

import (
	"net/http"
	"time"
)

// FeedTarget holds what a WebSocket client needs to open a feed of the server with the settings of
// this Client, as ChangeFeedTarget returns it.
type FeedTarget struct {
	// URL is the http or https address of the feed, which a WebSocket client reads as ws or wss.
	URL string
	// Header holds Config.Headers and the Authorization header of Config.APIKey, for the upgrade request.
	Header http.Header
	// HTTPClient is the Client's http.Client, which follows no redirects unless Config.HTTPClient does.
	HTTPClient *http.Client
}

// ChangeFeedTarget returns the address of the change feed of an index on the next server address in
// turn, with the headers and the http.Client of this Client. The subscriber in
// github.com/assetcorp/narsil/packages/go/changes opens its WebSocket there. It fails with
// CONFIG_INVALID when the client holds no server address.
func (c *Client) ChangeFeedTarget(index string) (FeedTarget, error) {
	order := c.transport.pool.order(time.Now())
	if len(order) == 0 {
		return FeedTarget{}, configInvalid("The client holds no server address")
	}
	entry := order[0]
	c.transport.pool.took(entry)
	return FeedTarget{
		URL:        entry.base + "/indexes/" + escapePathSegment(index) + "/changes/feed",
		Header:     c.transport.headers.Clone(),
		HTTPClient: c.transport.client,
	}, nil
}

// NewError returns an *Error under code, for a package that extends this client and reports its
// failures the way the client does. Unwrap returns cause, which may be nil.
func NewError(code, message string, details map[string]any, cause error) *Error {
	return newError(code, message, details, cause)
}

// ResponseError returns the *Error that an HTTP answer outside 2xx carries in its Narsil error envelope,
// with Status set, or CLIENT_INVALID_RESPONSE when the body holds no envelope.
func ResponseError(status int, body []byte, url string) *Error {
	return errorFromBody(status, body, url)
}

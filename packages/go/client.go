package narsil

import (
	"net/http"
	"sync"
	"time"
)

// Config holds the settings of a Client. Only URLs is required.
type Config struct {
	// URLs lists the address of every node that the client may send to, such as http://127.0.0.1:9876.
	// The client starts each call on the next address in turn, and it moves to another address under
	// the failover rules in the package documentation.
	URLs []string
	// APIKey is sent as "Authorization: Bearer <key>", which a server reads in its onRequest hook. For
	// any other scheme, set the header through Headers.
	APIKey string
	// Headers are sent with every request, and WithHeader replaces one of the same name for one call.
	Headers map[string]string
	// Timeout bounds each try of a call, 30 seconds unless you set it. NoTimeout waits for as long as the
	// server takes. While it stays unset, the methods that move a corpus or a whole index wait for as
	// long as the server takes, bounded only by the context of the call. Those are ImportNDJSON with the
	// ImportDocuments and StartImport helpers that call it, Snapshot, Restore, ExportDocuments, and
	// ImportDocumentExport.
	Timeout time.Duration
	// MaxResponseBytes makes the client stop reading an answer past this many bytes and fail with
	// CLIENT_INVALID_RESPONSE. Zero reads whatever the server sends. Snapshot and ExportDocuments hand
	// you a successful body as a stream, so for those two it bounds only an error answer.
	MaxResponseBytes int64
	// URLSkip is how long the client skips an address after it refuses a connection, one second unless
	// you set it, and twice as long after each further refusal.
	URLSkip time.Duration
	// MaxURLSkip caps URLSkip, 30 seconds unless you set it. A value below URLSkip fails with
	// CONFIG_INVALID.
	MaxURLSkip time.Duration
	// HTTPClient sends every request, in place of a client that follows no redirects. Leave the Timeout
	// of this http.Client at zero, because the client bounds each try through the context.
	HTTPClient *http.Client
}

// Operations holds one method for every route of the Narsil server, generated from its OpenAPI
// document. Client embeds it, and replaces Get, GetTask, IsAlive, and IsReady with friendlier forms.
type Operations struct {
	transport *transport
}

// Client calls a Narsil server, or every node of a cluster, over HTTP. It is safe to use from many
// goroutines at once.
type Client struct {
	Operations
	capabilitiesMutex sync.Mutex
	capabilities      map[string]bool
}

// New checks the settings and returns a Client. It fails with CONFIG_INVALID for an address that is not
// an http or https URL, or for a negative size or skip setting.
func New(config Config) (*Client, error) {
	pool, failure := newURLPool(config.URLs, config.URLSkip, config.MaxURLSkip)
	if failure != nil {
		return nil, failure
	}
	if config.MaxResponseBytes < 0 {
		return nil, configInvalid("Config.MaxResponseBytes takes 0 or more bytes, and it received %d", config.MaxResponseBytes)
	}
	headers := http.Header{}
	for name, value := range config.Headers {
		headers.Set(name, value)
	}
	if config.APIKey != "" {
		headers.Set("Authorization", "Bearer "+config.APIKey)
	}
	httpClient := config.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{
			Transport: http.DefaultTransport.(*http.Transport).Clone(),
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	timeout := config.Timeout
	if timeout < 0 {
		timeout = NoTimeout
	}
	return &Client{Operations: Operations{transport: &transport{
		client:           httpClient,
		pool:             pool,
		headers:          headers,
		timeout:          timeout,
		maxResponseBytes: config.MaxResponseBytes,
	}}}, nil
}

// CloseIdleConnections closes the connections that the client keeps open between calls.
func (c *Client) CloseIdleConnections() {
	c.transport.client.CloseIdleConnections()
}

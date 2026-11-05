package narsil

import (
	"net/http"
	"time"
)

const (
	defaultTimeout = 30 * time.Second
	noTimeout      = time.Duration(0)
)

// NoTimeout, set as Config.Timeout, makes the client wait for as long as the server takes on every try.
// The context of each call still bounds it.
const NoTimeout = time.Duration(-1)

// CallOption changes one call. Pass any number of them last.
type CallOption func(*callSettings)

type callSettings struct {
	timeout          *time.Duration
	headers          http.Header
	maxResponseBytes *int64
}

// WithTimeout makes the client wait this long for an answer on each try of this call, in place of
// Config.Timeout. Zero or less waits for as long as the server takes, bounded only by the context.
func WithTimeout(timeout time.Duration) CallOption {
	return func(settings *callSettings) {
		settings.timeout = &timeout
	}
}

// WithHeader adds a header to this call, replacing a header of the same name from Config.Headers.
func WithHeader(name, value string) CallOption {
	return func(settings *callSettings) {
		if settings.headers == nil {
			settings.headers = http.Header{}
		}
		settings.headers.Set(name, value)
	}
}

// WithMaxResponseBytes makes the client stop reading the answer of this call past this many bytes and
// fail with CLIENT_INVALID_RESPONSE, in place of Config.MaxResponseBytes. Zero reads whatever the
// server sends.
func WithMaxResponseBytes(limit int64) CallOption {
	return func(settings *callSettings) {
		settings.maxResponseBytes = &limit
	}
}

type resolvedCall struct {
	timeout time.Duration
	headers http.Header
	ceiling int64
}

func (t *transport) resolve(request exchange, options []CallOption) (resolvedCall, *Error) {
	settings := callSettings{}
	for _, option := range options {
		if option != nil {
			option(&settings)
		}
	}
	call := resolvedCall{headers: t.headers.Clone(), ceiling: t.maxResponseBytes}
	switch {
	case settings.timeout != nil:
		call.timeout = max(*settings.timeout, noTimeout)
	case t.timeout != 0:
		call.timeout = max(t.timeout, noTimeout)
	case request.carriesCorpus:
		call.timeout = noTimeout
	default:
		call.timeout = defaultTimeout
	}
	if settings.maxResponseBytes != nil {
		if *settings.maxResponseBytes < 0 {
			return call, configInvalid("WithMaxResponseBytes takes 0 or more bytes, and it received %d", *settings.maxResponseBytes)
		}
		call.ceiling = *settings.maxResponseBytes
	}
	for name, values := range settings.headers {
		call.headers[name] = values
	}
	if request.contentType != "" {
		call.headers.Set("Content-Type", request.contentType)
	}
	return call, nil
}

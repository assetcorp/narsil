package narsil

import (
	"encoding/json"
	"errors"
	"fmt"
)

// The client raises these codes itself, and no server sends them.
const (
	// CodeClientConnectionFailed means the client could not reach the server, or the connection broke
	// before the answer arrived.
	CodeClientConnectionFailed = "CLIENT_CONNECTION_FAILED"
	// CodeClientRequestTimeout means the deadline passed before the answer arrived.
	CodeClientRequestTimeout = "CLIENT_REQUEST_TIMEOUT"
	// CodeClientRequestAborted means the caller cancelled the context of the call.
	CodeClientRequestAborted = "CLIENT_REQUEST_ABORTED"
	// CodeClientInvalidResponse means the answer held no JSON, or not the shape that the route documents,
	// or it passed the byte ceiling.
	CodeClientInvalidResponse = "CLIENT_INVALID_RESPONSE"
	// CodeClientTaskTimeout means WaitForTask passed its WaitTimeout while the task kept running.
	CodeClientTaskTimeout = "CLIENT_TASK_TIMEOUT"
)

const (
	codeNodeNotReady  = "NODE_NOT_READY"
	codeDocNotFound   = "DOC_NOT_FOUND"
	codeTaskNotFound  = "TASK_NOT_FOUND"
	codeNotFound      = "NOT_FOUND"
	codeConfigInvalid = "CONFIG_INVALID"
)

// Error is what the client returns for every failure, under the code that the server sent.
//
// A code that starts with CLIENT_ means the failure happened on this side. Any other code is the one
// that the server or its onRequest hook wrote, passed through unchanged. Read it with errors.As.
type Error struct {
	// Code says what failed, such as DOC_NOT_FOUND.
	Code string
	// Message describes the failure, for a log or a person.
	Message string
	// Details holds the values behind the failure, as the server sent them.
	Details map[string]any
	// Status is the HTTP status of the answer that carried the error, and 0 where no answer arrived.
	Status int
	cause  error
}

// Error returns the code and the message, such as "DOC_NOT_FOUND: Document not found".
func (e *Error) Error() string {
	return e.Code + ": " + e.Message
}

// Unwrap returns the failure underneath, such as context.Canceled, so errors.Is can find it.
func (e *Error) Unwrap() error {
	return e.cause
}

// ErrorCode returns the code of a client error anywhere in the chain of err, and "" when err holds none.
func ErrorCode(err error) string {
	var failure *Error
	if errors.As(err, &failure) {
		return failure.Code
	}
	return ""
}

func newError(code, message string, details map[string]any, cause error) *Error {
	if details == nil {
		details = map[string]any{}
	}
	return &Error{Code: code, Message: message, Details: details, cause: cause}
}

func configInvalid(format string, values ...any) *Error {
	return newError(codeConfigInvalid, fmt.Sprintf(format, values...), nil, nil)
}

func invalidResponse(message string, details map[string]any) *Error {
	return newError(CodeClientInvalidResponse, message, details, nil)
}

type errorEnvelope struct {
	Error *struct {
		Code    *string         `json:"code"`
		Message *string         `json:"message"`
		Details json.RawMessage `json:"details"`
	} `json:"error"`
}

func envelopeOf(body []byte) (code, message string, details map[string]any, ok bool) {
	var envelope errorEnvelope
	if json.Unmarshal(body, &envelope) != nil || envelope.Error == nil {
		return "", "", nil, false
	}
	if envelope.Error.Code == nil || envelope.Error.Message == nil {
		return "", "", nil, false
	}
	details = map[string]any{}
	if len(envelope.Error.Details) > 0 {
		var decoded map[string]any
		if json.Unmarshal(envelope.Error.Details, &decoded) == nil && decoded != nil {
			details = decoded
		}
	}
	return *envelope.Error.Code, *envelope.Error.Message, details, true
}

func envelopeCode(body []byte) string {
	code, _, _, ok := envelopeOf(body)
	if !ok {
		return ""
	}
	return code
}

func errorFromBody(status int, body []byte, url string) *Error {
	code, message, details, ok := envelopeOf(body)
	if !ok {
		failure := invalidResponse(
			fmt.Sprintf("The server answered HTTP %d without a Narsil error envelope", status),
			map[string]any{"url": url, "status": status},
		)
		failure.Status = status
		return failure
	}
	details["status"] = status
	failure := newError(code, message, details, nil)
	failure.Status = status
	return failure
}

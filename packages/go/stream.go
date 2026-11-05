package narsil

import (
	"context"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"
)

// ResponseStream is the body of a successful answer that the client hands over unread, such as a
// snapshot archive or a document export. Read it as an io.Reader, and Close it once you are done so
// the connection goes back to the pool.
//
// A read error comes back as an *Error, under CLIENT_REQUEST_TIMEOUT once the per-try timeout or the
// context deadline passes, CLIENT_REQUEST_ABORTED once the context is cancelled, and
// CLIENT_CONNECTION_FAILED when the connection breaks.
type ResponseStream struct {
	// Status is the HTTP status of the answer.
	Status int
	// Header holds the headers of the answer, such as Content-Type.
	Header http.Header

	body      io.ReadCloser
	release   func()
	ctx       context.Context
	tryCtx    context.Context
	url       string
	timeout   time.Duration
	closeOnce sync.Once
	closeErr  error
}

// Read reads the next bytes of the body.
func (s *ResponseStream) Read(buffer []byte) (int, error) {
	count, err := s.body.Read(buffer)
	if err == nil || errors.Is(err, io.EOF) {
		return count, err
	}
	return count, translateFailure(s.ctx, s.tryCtx, err, s.url, s.timeout).failure
}

// Close closes the body and releases the connection. Calling it again does nothing.
func (s *ResponseStream) Close() error {
	s.closeOnce.Do(func() {
		s.closeErr = s.body.Close()
		if s.release != nil {
			s.release()
		}
	})
	return s.closeErr
}

package narsil

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"
)

type transport struct {
	client           *http.Client
	pool             *urlPool
	headers          http.Header
	timeout          time.Duration
	maxResponseBytes int64
}

type attempt struct {
	answer      *answered
	failure     *Error
	sentNothing bool
	final       bool
}

type errResponseTooLarge struct{ limit int64 }

func (e errResponseTooLarge) Error() string {
	return fmt.Sprintf("the answer passed the %d byte ceiling that this client reads", e.limit)
}

func readLimited(body io.Reader, ceiling int64) ([]byte, error) {
	if ceiling <= 0 {
		return io.ReadAll(body)
	}
	data, err := io.ReadAll(io.LimitReader(body, ceiling+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > ceiling {
		return nil, errResponseTooLarge{limit: ceiling}
	}
	return data, nil
}

type sizedReader interface {
	io.ReaderAt
	io.Seeker
	Size() int64
}

func replayableUpload(upload io.Reader) (func() io.Reader, int64, bool) {
	switch body := upload.(type) {
	case *bytes.Buffer:
		data := body.Bytes()
		return func() io.Reader { return bytes.NewReader(data) }, int64(len(data)), true
	case sizedReader:
		offset, err := body.Seek(0, io.SeekCurrent)
		if err != nil {
			return nil, 0, false
		}
		remaining := body.Size() - offset
		return func() io.Reader { return io.NewSectionReader(body, offset, remaining) }, remaining, true
	}
	return nil, 0, false
}

func translateFailure(ctx, tryCtx context.Context, err error, target string, timeout time.Duration) attempt {
	var tooLarge errResponseTooLarge
	if errors.As(err, &tooLarge) {
		failure := invalidResponse(
			fmt.Sprintf("The server at %s answered more than this client reads: %v", target, tooLarge),
			map[string]any{"url": target, "maxResponseBytes": tooLarge.limit},
		)
		return attempt{failure: failure}
	}
	if callerErr := ctx.Err(); callerErr != nil {
		if errors.Is(callerErr, context.DeadlineExceeded) {
			failure := newError(CodeClientRequestTimeout,
				fmt.Sprintf("The deadline of the call passed before %s answered", target),
				map[string]any{"url": target}, callerErr)
			return attempt{failure: failure, final: true}
		}
		failure := newError(CodeClientRequestAborted,
			fmt.Sprintf("The caller cancelled the request to %s", target),
			map[string]any{"url": target}, callerErr)
		return attempt{failure: failure, final: true}
	}
	if errors.Is(tryCtx.Err(), context.DeadlineExceeded) {
		failure := newError(CodeClientRequestTimeout,
			fmt.Sprintf("The server at %s did not answer within %s", target, timeout),
			map[string]any{"url": target, "timeoutMs": timeout.Milliseconds()}, err)
		return attempt{failure: failure}
	}
	var dialFailure *net.OpError
	sentNothing := errors.As(err, &dialFailure) && dialFailure.Op == "dial"
	failure := newError(CodeClientConnectionFailed,
		fmt.Sprintf("The client could not reach %s: %v", target, err),
		map[string]any{"url": target}, err)
	return attempt{failure: failure, sentNothing: sentNothing}
}

func (t *transport) try(ctx context.Context, entry *urlEntry, request exchange, call resolvedCall,
	replay func() io.Reader, length int64, keepStream bool) attempt {
	t.pool.took(entry)
	target := entry.base + request.path
	if len(request.query) > 0 {
		target += "?" + request.query.Encode()
	}
	if ctx.Err() != nil {
		return translateFailure(ctx, ctx, ctx.Err(), target, call.timeout)
	}
	var tryCtx context.Context
	var cancel context.CancelFunc
	if call.timeout > 0 {
		tryCtx, cancel = context.WithTimeout(ctx, call.timeout)
	} else {
		tryCtx, cancel = context.WithCancel(ctx)
	}
	var body io.Reader
	switch {
	case replay != nil:
		body = replay()
	case request.upload != nil:
		body = request.upload
	}
	httpRequest, err := http.NewRequestWithContext(tryCtx, request.method, target, body)
	if err != nil {
		cancel()
		return attempt{failure: configInvalid("The client cannot build a request to %s: %v", target, err), final: true}
	}
	if replay != nil {
		httpRequest.ContentLength = length
		httpRequest.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(replay()), nil }
		if length == 0 {
			httpRequest.Body = http.NoBody
			httpRequest.GetBody = func() (io.ReadCloser, error) { return http.NoBody, nil }
		}
	}
	httpRequest.Header = call.headers.Clone()
	response, err := t.client.Do(httpRequest)
	if err != nil {
		failed := translateFailure(ctx, tryCtx, err, target, call.timeout)
		cancel()
		return failed
	}
	if keepStream && response.StatusCode >= 200 && response.StatusCode < 300 {
		return attempt{answer: &answered{
			status: response.StatusCode, header: response.Header, url: target, response: response, release: cancel,
			tryCtx: tryCtx, timeout: call.timeout,
		}}
	}
	data, err := readLimited(response.Body, call.ceiling)
	_ = response.Body.Close()
	if err != nil {
		failed := translateFailure(ctx, tryCtx, err, target, call.timeout)
		cancel()
		return failed
	}
	cancel()
	return attempt{answer: &answered{status: response.StatusCode, header: response.Header, body: data, url: target}}
}

func (t *transport) record(entry *urlEntry, outcome attempt, repeatable bool) bool {
	if outcome.answer != nil {
		if !answersUnavailable(outcome.answer.status) {
			t.pool.answered(entry)
			return false
		}
		return movesOnAfterAnswer(outcome.answer.status, envelopeCode(outcome.answer.body), repeatable)
	}
	if outcome.final {
		return false
	}
	if outcome.failure.Code == CodeClientConnectionFailed {
		t.pool.refused(entry, time.Now())
	}
	return movesOnAfterFailure(outcome.failure, outcome.sentNothing, repeatable)
}

func (t *transport) send(ctx context.Context, request exchange, options []CallOption, keepStream bool) (*answered, error) {
	call, failure := t.resolve(request, options)
	if failure != nil {
		return nil, failure
	}
	repeatable := request.repeatable || request.method == http.MethodGet
	var replay func() io.Reader
	var length int64
	replayable := true
	switch {
	case request.payload != nil:
		payload := request.payload
		replay, length = func() io.Reader { return bytes.NewReader(payload) }, int64(len(payload))
	case request.upload != nil:
		replay, length, replayable = replayableUpload(request.upload)
	}
	triesOnceMore := repeatable && replayable
	var last attempt
	tried := false
	for _, entry := range t.pool.order(time.Now()) {
		last = t.try(ctx, entry, request, call, replay, length, keepStream)
		tried = true
		moves := t.record(entry, last, repeatable)
		if !replayable || !moves {
			return outcomeOf(last)
		}
		if last.failure != nil && last.failure.Code != CodeClientConnectionFailed {
			triesOnceMore = false
		}
	}
	if !tried {
		return nil, configInvalid("The client holds no server address")
	}
	if order := t.pool.order(time.Now()); triesOnceMore && len(order) > 0 {
		last = t.try(ctx, order[0], request, call, replay, length, keepStream)
		t.record(order[0], last, repeatable)
	}
	return outcomeOf(last)
}

func outcomeOf(last attempt) (*answered, error) {
	if last.failure != nil {
		return nil, last.failure
	}
	return last.answer, nil
}

func (t *transport) exchange(ctx context.Context, request exchange, options []CallOption) (*answered, error) {
	answer, err := t.send(ctx, request, options, false)
	if err != nil {
		return nil, err
	}
	if answer.status < 200 || answer.status >= 300 {
		return nil, errorFromBody(answer.status, answer.body, answer.url)
	}
	return answer, nil
}

func (t *transport) stream(ctx context.Context, request exchange, options []CallOption) (*ResponseStream, error) {
	answer, err := t.send(ctx, request, options, true)
	if err != nil {
		return nil, err
	}
	if answer.status < 200 || answer.status >= 300 {
		return nil, errorFromBody(answer.status, answer.body, answer.url)
	}
	if answer.response == nil {
		return nil, invalidResponse(
			fmt.Sprintf("The server answered %s without a body", answer.url), map[string]any{"url": answer.url},
		)
	}
	return &ResponseStream{
		Status: answer.status, Header: answer.header, body: answer.response.Body, release: answer.release,
		ctx: ctx, tryCtx: answer.tryCtx, url: answer.url, timeout: answer.timeout,
	}, nil
}

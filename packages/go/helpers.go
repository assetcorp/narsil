package narsil

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"time"
)

// The capabilities that a server can announce at GET /capabilities, which Supports reads.
const (
	CapabilityAsyncImport     = "documents.import.async"
	CapabilityTaskCancel      = "tasks.cancel"
	CapabilityTaskFilter      = "tasks.filter"
	CapabilityRebuildAnalysis = "indexes.rebuildAnalysis"
	CapabilityChangeAnalysis  = "indexes.changeAnalysis"
	CapabilityIndexLifecycle  = "indexes.lifecycle"
	CapabilityDocumentExport  = "indexes.documentExport"
	CapabilitySynonyms        = "indexes.synonyms"
	CapabilityBM25Tuning      = "indexes.bm25"
)

const defaultTaskPollInterval = 250 * time.Millisecond

// Get returns one document, or nil and no error when the index holds no document under that id. The
// client encodes the id, so an id that holds a slash, a space, or an accent reaches the document stored
// under that id.
func (c *Client) Get(ctx context.Context, name, id string, options ...CallOption) (AnyDocument, error) {
	answer, err := c.Operations.Get(ctx, name, id, options...)
	if ErrorCode(err) == codeDocNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if answer.Document == nil {
		return AnyDocument{}, nil
	}
	return answer.Document, nil
}

// GetTask returns one task record, or nil and no error once the server no longer holds it.
func (c *Client) GetTask(ctx context.Context, id string, options ...CallOption) (*TaskRecord, error) {
	record, err := c.Operations.GetTask(ctx, id, options...)
	if ErrorCode(err) == codeTaskNotFound {
		return nil, nil
	}
	return record, err
}

func (c *Client) probe(ctx context.Context, path string, options []CallOption) (bool, error) {
	answer, err := c.transport.send(ctx, exchange{method: http.MethodGet, path: path}, options, false)
	if err != nil {
		return false, err
	}
	return answer.status == http.StatusOK, nil
}

// IsAlive reports whether the server process answers GET /livez with 200. It returns an error only when
// no server answered at all.
func (c *Client) IsAlive(ctx context.Context, options ...CallOption) (bool, error) {
	return c.probe(ctx, "/livez", options)
}

// IsReady reports whether the server answers GET /readyz with 200, and returns false when it answers
// 503, which it does while it starts up and again once it starts draining. It returns an error only
// when no server answered at all.
func (c *Client) IsReady(ctx context.Context, options ...CallOption) (bool, error) {
	return c.probe(ctx, "/readyz", options)
}

// Supports reports whether the server announces capability at GET /capabilities, such as
// CapabilityAsyncImport. The client reads the list once and keeps it, because a server takes on a
// capability only when it restarts. A server that predates the endpoint answers 404, and the client then
// reports that it supports nothing.
func (c *Client) Supports(ctx context.Context, capability string, options ...CallOption) (bool, error) {
	c.capabilitiesMutex.Lock()
	defer c.capabilitiesMutex.Unlock()
	if c.capabilities == nil {
		answer, err := c.Capabilities(ctx, options...)
		if err != nil && ErrorCode(err) != codeNotFound {
			return false, err
		}
		known := map[string]bool{}
		if answer != nil {
			for _, name := range answer.Capabilities {
				known[name] = true
			}
		}
		c.capabilities = known
	}
	return c.capabilities[capability], nil
}

// WaitOptions changes how WaitForTask polls.
type WaitOptions struct {
	// PollInterval is how long the client waits between polls, 250 milliseconds unless you set it.
	PollInterval time.Duration
	// WaitTimeout makes WaitForTask fail with CLIENT_TASK_TIMEOUT once it passes while the task keeps
	// running. The wait otherwise lasts as long as the task does, bounded only by the context.
	WaitTimeout time.Duration
	// OnProgress is called each time the record changes, and never twice for the same figures.
	OnProgress func(*TaskRecord)
}

func progressKey(record *TaskRecord) string {
	if record.Progress == nil {
		return string(record.Status)
	}
	progress := record.Progress
	return fmt.Sprintf("%s:%v:%v:%v", record.Status, progress.BytesProcessed, progress.Indexed, progress.Failed)
}

func isTerminal(record *TaskRecord) bool {
	switch record.Status {
	case TaskStatusSucceeded, TaskStatusFailed, TaskStatusCancelled:
		return true
	}
	return false
}

// WaitForTask polls a task until it reaches succeeded, failed, or cancelled, and returns that record. A
// failed task comes back with its Error set and no Go error, because a part-finished import still
// reports what it indexed, so read the Status of the record. It fails with TASK_NOT_FOUND when the
// server drops the record before the task ends, with CLIENT_TASK_TIMEOUT once WaitTimeout passes, and
// with CLIENT_REQUEST_ABORTED or CLIENT_REQUEST_TIMEOUT once the context ends.
func (c *Client) WaitForTask(ctx context.Context, taskID string, wait WaitOptions, options ...CallOption) (*TaskRecord, error) {
	if wait.PollInterval < 0 || wait.WaitTimeout < 0 {
		return nil, configInvalid("WaitOptions.PollInterval and WaitOptions.WaitTimeout take 0 or more")
	}
	interval := wait.PollInterval
	if interval == 0 {
		interval = defaultTaskPollInterval
	}
	started := time.Now()
	reported := ""
	for {
		record, err := c.GetTask(ctx, taskID, options...)
		if err != nil {
			return nil, err
		}
		if record == nil {
			return nil, newError(codeTaskNotFound,
				fmt.Sprintf("The server no longer holds task %q, so its outcome is unknown", taskID),
				map[string]any{"taskId": taskID}, nil)
		}
		if key := progressKey(record); key != reported {
			reported = key
			if wait.OnProgress != nil {
				wait.OnProgress(record)
			}
		}
		if isTerminal(record) {
			return record, nil
		}
		if wait.WaitTimeout > 0 && time.Since(started) >= wait.WaitTimeout {
			return nil, newError(CodeClientTaskTimeout,
				fmt.Sprintf("Task %q was still %s after %s, and it keeps running", taskID, record.Status, wait.WaitTimeout),
				map[string]any{"taskId": taskID, "waitTimeoutMs": wait.WaitTimeout.Milliseconds(), "status": string(record.Status)},
				nil)
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, translateFailure(ctx, ctx, ctx.Err(), "task "+taskID, 0).failure
		case <-timer.C:
		}
	}
}

func encodeNDJSON(documents []AnyDocument) ([]byte, error) {
	var buffer bytes.Buffer
	for position, document := range documents {
		line, err := encodeJSON(document)
		if err != nil {
			return nil, fmt.Errorf("narsil: document %d: %w", position, err)
		}
		if position > 0 {
			buffer.WriteByte('\n')
		}
		buffer.Write(line)
	}
	return buffer.Bytes(), nil
}

// ImportDocuments loads documents in one request and returns once the whole load has finished. One bad
// record never abandons the rest, because the server notes each failure and carries on. Use
// ImportNDJSON to send NDJSON that you already hold or stream.
func (c *Client) ImportDocuments(ctx context.Context, name string, documents []AnyDocument, options ...CallOption) (*ImportResult, error) {
	payload, err := encodeNDJSON(documents)
	if err != nil {
		return nil, err
	}
	answer, err := c.ImportNDJSON(ctx, name, bytes.NewReader(payload), ImportNDJSONParams{}, options...)
	if err != nil {
		return nil, err
	}
	if answer.ImportResult == nil {
		return nil, invalidResponse("The server answered the import with a task where it should have finished the load", nil)
	}
	return answer.ImportResult, nil
}

// StartImport uploads documents and returns the task that loads them, which WaitForTask follows.
func (c *Client) StartImport(ctx context.Context, name string, documents []AnyDocument, options ...CallOption) (*TaskRecord, error) {
	payload, err := encodeNDJSON(documents)
	if err != nil {
		return nil, err
	}
	answer, err := c.ImportNDJSON(ctx, name, bytes.NewReader(payload), ImportNDJSONParams{Async: Ptr("true")}, options...)
	if err != nil {
		return nil, err
	}
	if answer.TaskRecord == nil {
		return nil, invalidResponse("The server answered the import with a finished load where it should have started a task", nil)
	}
	return answer.TaskRecord, nil
}

// InsertBatch inserts many documents in one request, and returns the ids it wrote and each refusal.
// Pass nil insertOptions to keep the server defaults.
func (c *Client) InsertBatch(ctx context.Context, name string, documents []AnyDocument, insertOptions *InsertOptions, options ...CallOption) (*BatchResponse, error) {
	return c.WriteBatch(ctx, name, BatchBody{Action: Ptr("insert"), Documents: documents, Options: insertOptions}, options...)
}

// UpdateBatch replaces many documents in one request. Each update holds a DocID and a Document.
func (c *Client) UpdateBatch(ctx context.Context, name string, updates []BatchBodyUpdatesItem, insertOptions *InsertOptions, options ...CallOption) (*BatchResponse, error) {
	return c.WriteBatch(ctx, name, BatchBody{Action: Ptr("update"), Updates: updates, Options: insertOptions}, options...)
}

// RemoveBatch removes many documents in one request, and returns the ids it removed and each refusal.
func (c *Client) RemoveBatch(ctx context.Context, name string, docIDs []string, insertOptions *InsertOptions, options ...CallOption) (*BatchResponse, error) {
	return c.WriteBatch(ctx, name, BatchBody{Action: Ptr("delete"), DocIDs: docIDs, Options: insertOptions}, options...)
}

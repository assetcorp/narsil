package changes

import (
	"errors"
	"io"
	"iter"

	narsil "github.com/assetcorp/narsil/packages/go"
	"github.com/coder/websocket"
)

// Next waits for the next event and returns it. The first event is a *Subscribed, each later one a
// *Batch, and the last one a *Resync where the positions no longer lead to the index's changes.
//
// It returns io.EOF after a *Resync and after Close. It returns an *narsil.Error with
// CHANGES_NOT_ENABLED when capture turns off, with the code in the close reason when the index's setting
// refuses the subscription, with CONFIG_INVALID when the server refuses the epoch, the positions, or the
// filter, with CLIENT_INVALID_RESPONSE when the server sends a message that breaks the protocol, and with
// CLIENT_CONNECTION_FAILED when the connection fails or the credential expires, in which case follow
// again from the saved positions. Once it returns an error, it returns the same error on every call.
func (s *Subscription) Next() (Event, error) {
	s.reading.Lock()
	defer s.reading.Unlock()
	if done, err := s.outcome(); done {
		return nil, err
	}
	kind, data, err := s.conn.Read(s.ctx)
	if err != nil {
		if s.closing.Load() {
			return nil, s.finish(nil)
		}
		return nil, s.finish(s.redact.failure(s.ctx, s.url, err))
	}
	if kind != websocket.MessageBinary {
		return nil, s.finish(narsil.NewError(narsil.CodeClientInvalidResponse, "The change feed sent a text frame", nil, nil))
	}
	raw, err := decodeMessage(data)
	if err != nil {
		return nil, s.finish(narsil.NewError(narsil.CodeClientInvalidResponse,
			"The change feed sent a message that is not MessagePack: "+err.Error(), nil, nil))
	}
	event, err := s.accept(raw)
	if err != nil {
		return nil, s.finish(err)
	}
	if _, resync := event.(*Resync); resync {
		_ = s.finish(nil)
	}
	return event, nil
}

func (s *Subscription) accept(raw any) (Event, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if s.state != nil {
		return laterEventOf(raw, s.state)
	}
	subscribed, state, err := subscribedOf(raw)
	if err != nil {
		return nil, err
	}
	s.state = state
	s.saved = make([]uint64, state.partitionCount)
	copy(s.saved, state.scanned)
	return subscribed, nil
}

func (s *Subscription) outcome() (bool, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if !s.ended {
		return false, nil
	}
	if s.failure != nil {
		return true, s.failure
	}
	return true, io.EOF
}

func (s *Subscription) finish(failure error) error {
	s.mutex.Lock()
	if !s.ended {
		s.ended = true
		s.failure = failure
	}
	outcome := s.failure
	s.mutex.Unlock()
	s.stopCancel()
	_ = s.conn.CloseNow()
	if outcome == nil {
		return io.EOF
	}
	return outcome
}

// All returns the events of Next for a range loop, which ends without an error after a *Resync or
// Close, and after yielding the one error that ends the subscription. The loop body may call Ack and
// Close. All closes the subscription when the loop ends.
func (s *Subscription) All() iter.Seq2[Event, error] {
	return func(yield func(Event, error) bool) {
		defer s.Close()
		for {
			event, err := s.Next()
			if errors.Is(err, io.EOF) || !yield(event, err) || err != nil {
				return
			}
		}
	}
}

// Ack tells the server that the caller has saved these positions, which frees the window for further
// changes. Pass only saved positions, each at or below a ScannedSeqNo that the feed returned or the
// partition's position in Subscribed. Ack keeps the highest saved position of every partition and
// sends all of them, because the server expects each acknowledgement to name every partition once.
//
// It fails with CHANGES_INVALID_POSITIONS for a partition that the index lacks or for a position above
// what the feed returned, and it does nothing before the *Subscribed event or once the subscription
// has ended.
func (s *Subscription) Ack(positions []Position) error {
	message, err := s.ackMessage(positions)
	if message == nil || err != nil {
		return err
	}
	if err := s.conn.Write(s.ctx, websocket.MessageBinary, message); err != nil {
		if s.closing.Load() {
			return nil
		}
		return s.redact.failure(s.ctx, s.url, err)
	}
	return nil
}

func (s *Subscription) ackMessage(positions []Position) ([]byte, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if s.state == nil {
		return nil, nil
	}
	for _, position := range positions {
		if position.PartitionID >= s.state.partitionCount {
			return nil, narsil.NewError(codeChangesInvalidPositions, "The index has no such partition",
				map[string]any{"partitionId": position.PartitionID, "partitionCount": s.state.partitionCount}, nil)
		}
		if position.SeqNo > s.state.scanned[position.PartitionID] {
			return nil, narsil.NewError(codeChangesInvalidPositions, "The position lies above what the feed returned",
				map[string]any{"partitionId": position.PartitionID, "seqNo": position.SeqNo}, nil)
		}
	}
	if s.ended {
		return nil, nil
	}
	for _, position := range positions {
		s.saved[position.PartitionID] = max(s.saved[position.PartitionID], position.SeqNo)
	}
	every := make([]Position, len(s.saved))
	for partitionID, seqNo := range s.saved {
		every[partitionID] = Position{PartitionID: uint32(partitionID), SeqNo: seqNo}
	}
	return boundedMessage(map[string]any{"type": "ack", "positions": positionList(every)})
}

// Close closes the connection with a close handshake, after which Next returns io.EOF. Calling it again
// does nothing.
func (s *Subscription) Close() error {
	if !s.closing.CompareAndSwap(false, true) {
		return nil
	}
	s.stopCancel()
	_ = s.conn.Close(websocket.StatusNormalClosure, closeReasonSubscriber)
	s.mutex.Lock()
	s.ended = true
	s.mutex.Unlock()
	return nil
}

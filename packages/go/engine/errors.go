package engine

import "github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"

// Error is what every failed engine call returns, carrying the same code that
// the TypeScript package raises for the same failure. Reach it with
// errors.As, then read Code to decide what to do, Message to show a person,
// and Details for the values that caused the failure.
type Error = narsilerr.Error

// ErrorCode returns the engine code that err carries, or an empty string when
// err is nil or came from somewhere other than the engine.
func ErrorCode(err error) string {
	return narsilerr.CodeOf(err)
}

// AsError returns the engine error inside err, and false when err holds none.
func AsError(err error) (*Error, bool) {
	return narsilerr.As(err)
}

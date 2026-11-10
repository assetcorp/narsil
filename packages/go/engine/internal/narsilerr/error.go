package narsilerr

import (
	"errors"
	"fmt"
)

type Error struct {
	Code    string
	Message string
	Details map[string]any
	cause   error
}

func (e *Error) Error() string {
	return e.Code + ": " + e.Message
}

func (e *Error) Unwrap() error {
	return e.cause
}

func New(code, message string, details map[string]any) *Error {
	if details == nil {
		details = map[string]any{}
	}
	return &Error{Code: code, Message: message, Details: details}
}

func Newf(code, format string, arguments ...any) *Error {
	return New(code, fmt.Sprintf(format, arguments...), nil)
}

func Wrap(code, message string, cause error, details map[string]any) *Error {
	failure := New(code, message, details)
	failure.cause = cause
	if cause != nil {
		failure.Details["cause"] = cause.Error()
	}
	return failure
}

func (e *Error) CausedBy(cause error) *Error {
	e.cause = cause
	return e
}

func As(err error) (*Error, bool) {
	var failure *Error
	if errors.As(err, &failure) {
		return failure, true
	}
	return nil, false
}

func CodeOf(err error) string {
	if failure, ok := As(err); ok {
		return failure.Code
	}
	return ""
}

func Passthrough(err error, code, message string) error {
	if _, ok := As(err); ok {
		return err
	}
	return Wrap(code, message, err, nil)
}

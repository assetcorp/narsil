package changes

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"

	narsil "github.com/assetcorp/narsil/packages/go"
	"github.com/coder/websocket"
)

// The close codes of the change feed, which an *narsil.Error from a closed feed holds under the
// "closeCode" key of Details.
const (
	CloseGoingAway         = 1001
	ClosePolicy            = 1008
	CloseTooLarge          = 1009
	CloseServerError       = 1011
	CloseCredentialExpired = 4401
	CloseSetting           = 4409
	CloseResync            = 4410
)

const (
	codeConfigInvalid           = "CONFIG_INVALID"
	codeChangesNotEnabled       = "CHANGES_NOT_ENABLED"
	codeChangesInvalidPositions = "CHANGES_INVALID_POSITIONS"
	redactedCredential          = "[credential]"
)

var errorCodePattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)

// CloseCode returns the close code of the feed connection behind err, and 0 when err holds none.
func CloseCode(err error) int {
	var failure *narsil.Error
	if !errors.As(err, &failure) {
		return 0
	}
	code, _ := failure.Details["closeCode"].(int)
	return code
}

func closedError(code int, reason string) *narsil.Error {
	details := map[string]any{"closeCode": code}
	switch {
	case code == CloseSetting && errorCodePattern.MatchString(reason):
		return narsil.NewError(reason, "The server refused the subscription with "+reason, details, nil)
	case code == CloseResync:
		return narsil.NewError(codeChangesNotEnabled, "The index has change capture off", details, nil)
	case code == ClosePolicy:
		return narsil.NewError(codeConfigInvalid, "The server refused the subscription: "+reason, details, nil)
	case code == CloseCredentialExpired:
		return narsil.NewError(narsil.CodeClientConnectionFailed,
			"The change feed ended because the credential expired", details, nil)
	}
	details["reason"] = reason
	return narsil.NewError(narsil.CodeClientConnectionFailed,
		fmt.Sprintf("The change feed ended because the server closed it with code %d", code), details, nil)
}

func configInvalid(message string) *narsil.Error {
	return narsil.NewError(codeConfigInvalid, message, nil, nil)
}

type redactor struct {
	credential string
}

func (r redactor) text(value string) string {
	if r.credential == "" {
		return value
	}
	return strings.ReplaceAll(value, r.credential, redactedCredential)
}

func (r redactor) cause(err error) error {
	if r.credential == "" || !strings.Contains(err.Error(), r.credential) {
		return err
	}
	return errors.New(r.text(err.Error()))
}

func (r redactor) failure(ctx context.Context, url string, err error) *narsil.Error {
	details := map[string]any{"url": url}
	if callerErr := ctx.Err(); callerErr != nil {
		if errors.Is(callerErr, context.DeadlineExceeded) {
			return narsil.NewError(narsil.CodeClientRequestTimeout,
				"The deadline of the subscription passed", details, callerErr)
		}
		return narsil.NewError(narsil.CodeClientRequestAborted,
			"The caller cancelled the subscription", details, callerErr)
	}
	if errors.Is(err, websocket.ErrMessageTooBig) {
		return narsil.NewError(narsil.CodeClientInvalidResponse,
			"The change feed sent a message longer than Options.MaxMessageBytes", details, nil)
	}
	var closed websocket.CloseError
	if errors.As(err, &closed) {
		return closedError(int(closed.Code), closed.Reason)
	}
	return narsil.NewError(narsil.CodeClientConnectionFailed,
		"The change feed at "+url+" failed: "+r.text(err.Error()), details, r.cause(err))
}

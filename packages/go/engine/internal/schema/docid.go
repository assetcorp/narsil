package schema

import (
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const documentIDField = "id"

const unpairedSurrogateReason = "holds an unpaired surrogate, the half of a character such as an emoji whose other half is missing, so the engine cannot store it as UTF-8"

func utf16Length(text string) int {
	length := 0
	for _, character := range text {
		if character >= 0x10000 {
			length += 2
		} else {
			length++
		}
	}
	return length
}

func ValidateDocID(docID string) error {
	if docID == "" {
		return narsilerr.New(narsilerr.CodeDocValidationFailed, "Document ID must not be empty", map[string]any{"docId": docID})
	}
	if !utf8.ValidString(docID) {
		return narsilerr.New(narsilerr.CodeDocValidationFailed, "Document ID "+unpairedSurrogateReason, map[string]any{"docId": strings.ToValidUTF8(docID, "�")})
	}
	if length := utf16Length(docID); length > MaxDocIDLength {
		return narsilerr.New(
			narsilerr.CodeDocValidationFailed,
			fmt.Sprintf("Document ID must not exceed %d characters", MaxDocIDLength),
			map[string]any{"docId": docID, "length": length},
		)
	}
	if strings.ContainsRune(docID, 0) {
		return narsilerr.New(narsilerr.CodeDocValidationFailed, "Document ID must not contain null bytes", map[string]any{"docId": docID})
	}
	return nil
}

func ProvidedDocID(document model.Document) (string, bool) {
	id, isText := textOf(document[documentIDField])
	if !isText || id == "" {
		return "", false
	}
	return id, true
}

func RequireMatchingDocID(docID string, document model.Document) error {
	embedded, found := ProvidedDocID(document)
	if !found || embedded == docID {
		return nil
	}
	return narsilerr.New(
		narsilerr.CodeDocValidationFailed,
		fmt.Sprintf("The call names document id %q while the document's own id field is %q, so the stored document would contradict the key that it is stored under", docID, embedded),
		map[string]any{"docId": docID, "documentId": embedded},
	)
}

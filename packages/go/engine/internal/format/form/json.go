package form

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const CodeJSONForm = narsilerr.CodePersistenceSaveFailed

func Encode(value map[string]any) ([]byte, error) {
	return codec.AppendDocumentJSON(nil, value, "")
}

func Decode(data []byte) (map[string]any, error) {
	parsed, err := codec.ParseJSON(data, CodeJSONForm)
	if err != nil {
		return nil, err
	}
	record, ok := parsed.(map[string]any)
	if !ok {
		return nil, narsilerr.New(CodeJSONForm, "The JSON form is not an object", nil)
	}
	return codec.UntagDocumentLine(string(data), record)
}

type HeaderForm struct {
	FormatVersion uint8
	Gzip          bool
	Checksum      bool
}

func HeaderOf(header envelope.Header) HeaderForm {
	return HeaderForm{FormatVersion: header.FormatVersion, Gzip: header.Compressed(), Checksum: header.HasChecksum()}
}

func (header HeaderForm) Value() map[string]any {
	compression := "none"
	if header.Gzip {
		compression = "gzip"
	}
	return map[string]any{
		"envelopeFormatVersion": float64(header.FormatVersion),
		"compression":           compression,
		"checksum":              header.Checksum,
	}
}

func HeaderFrom(fields *Fields) HeaderForm {
	header := HeaderForm{
		FormatVersion: uint8(fields.Uint("envelopeFormatVersion", 255)),
		Checksum:      fields.Bool("checksum"),
	}
	switch fields.String("compression") {
	case "gzip":
		header.Gzip = true
	case "none":
	default:
		fields.Fail("compression", "is neither \"none\" nor \"gzip\"")
	}
	return header
}

func (header HeaderForm) PackOptions(what string) envelope.PackOptions {
	return envelope.PackOptions{
		FormatVersion: header.FormatVersion,
		What:          what,
		Gzip:          header.Gzip,
		Checksum:      header.Checksum,
	}
}

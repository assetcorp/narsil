package schema

import "github.com/assetcorp/narsil/packages/go/engine/internal/model"

type DocumentRules struct {
	PatternValueLimit int
	Strict            bool
}

type PreparedDocument struct {
	Document model.Document
	Vectors  map[string][]float32
}

func PrepareDocument(document model.Document, parsed *Parsed, rules DocumentRules) (PreparedDocument, error) {
	if err := RequireDocumentWithinSizeLimit(document, parsed); err != nil {
		return PreparedDocument{}, err
	}
	normalised, err := NormalizeDocument(document, parsed)
	if err != nil {
		return PreparedDocument{}, err
	}
	vectors := extractVectors(normalised, parsed)
	if err := ValidateVectorDimensions(vectors, parsed); err != nil {
		return PreparedDocument{}, err
	}
	if err := ValidateDocument(normalised, parsed, rules.PatternValueLimit); err != nil {
		return PreparedDocument{}, err
	}
	if rules.Strict {
		if err := ValidateDocumentStrict(normalised, parsed); err != nil {
			return PreparedDocument{}, err
		}
	}
	return PreparedDocument{Document: normalised, Vectors: vectors}, nil
}

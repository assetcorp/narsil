package checkpoint

import (
	"context"
	"io"
	"os"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/paged"
)

func headerOfFile(path string) (envelope.Header, bool) {
	file, err := os.Open(path)
	if err != nil {
		return envelope.Header{}, false
	}
	defer file.Close()
	header := make([]byte, envelope.HeaderBytes)
	if _, err := io.ReadFull(file, header); err != nil {
		return envelope.Header{}, false
	}
	parsed, err := envelope.ParseHeader(header)
	return parsed, err == nil
}

func ListedPagedPath(ctx context.Context, store Store, ref manifest.FileRef) (string, bool, error) {
	path, held := store.PathOf(ref.Key)
	if !held {
		return "", false, nil
	}
	header, read := headerOfFile(path)
	if !read || header.FormatVersion != paged.EnvelopeVersion {
		return "", false, nil
	}
	size, found, err := store.Size(ctx, ref.Key)
	if err != nil {
		return "", false, err
	}
	if !found {
		return "", false, missingListedFile(ref.Key, "segment")
	}
	if uint64(size) != ref.Bytes {
		return "", false, manifest.RequireListedFile(ref, size, ref.Checksum, "segment")
	}
	return path, true, RequireChecksum(ref, header, "segment")
}

package codec

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

var ErrInflatesPastLimit = errors.New("the compressed data inflates past the byte limit")

func Gzip(data []byte) ([]byte, error) {
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write(data); err != nil {
		return nil, narsilerr.Wrap(narsilerr.CodePersistenceSaveFailed, "The payload fails to compress", err, nil)
	}
	if err := writer.Close(); err != nil {
		return nil, narsilerr.Wrap(narsilerr.CodePersistenceSaveFailed, "The payload fails to compress", err, nil)
	}
	return compressed.Bytes(), nil
}

func Gunzip(compressed []byte, maxBytes int64, code string) ([]byte, error) {
	source := bytes.NewReader(compressed)
	reader, err := gzip.NewReader(source)
	if err != nil {
		return nil, narsilerr.Wrap(code, "The gzip payload fails to inflate", err, nil)
	}
	defer reader.Close()
	reader.Multistream(false)
	var inflated bytes.Buffer
	chunk := make([]byte, gunzipReadChunkBytes)
	for {
		read, readErr := reader.Read(chunk)
		if int64(inflated.Len())+int64(read) > maxBytes {
			return nil, narsilerr.Wrap(
				code,
				"The compressed data inflates past "+strconv.FormatInt(maxBytes, 10)+" bytes",
				ErrInflatesPastLimit,
				map[string]any{"maxBytes": maxBytes},
			)
		}
		inflated.Write(chunk[:read])
		if errors.Is(readErr, io.EOF) {
			if source.Len() > 0 {
				return nil, narsilerr.New(code, "The gzip payload holds bytes after the end of its compressed stream",
					map[string]any{"trailingBytes": source.Len()})
			}
			return inflated.Bytes(), nil
		}
		if readErr != nil {
			return nil, narsilerr.Wrap(code, "The gzip payload fails to inflate", readErr, nil)
		}
	}
}

func SHA256Hex(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

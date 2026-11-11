package engine

import (
	"crypto/rand"
	"encoding/hex"
	"time"
)

func generateDocumentID() string {
	var bytes [defaultDocumentIDRandomBytes]byte
	_, _ = rand.Read(bytes[:])
	now := uint64(time.Now().UnixMilli())
	for at := range documentIDTimestampBytes {
		bytes[at] = byte(now >> (8 * (documentIDTimestampBytes - 1 - at)))
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x70
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	text := hex.EncodeToString(bytes[:])
	return text[0:8] + "-" + text[8:12] + "-" + text[12:16] + "-" + text[16:20] + "-" + text[20:]
}

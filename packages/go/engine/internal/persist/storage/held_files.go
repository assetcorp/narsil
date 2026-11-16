package storage

import (
	"os"
	"time"
)

func retriedWhileHeld(operation func() error, retriesMissing bool) error {
	err := operation()
	if err == nil || !heldByAnotherHandle(err, retriesMissing) {
		return err
	}
	deadline := time.Now().Add(heldFileRetryWindow)
	pause := heldFileRetryFirstPause
	for time.Now().Add(pause).Before(deadline) {
		time.Sleep(pause)
		err = operation()
		if err == nil || !heldByAnotherHandle(err, retriesMissing) {
			return err
		}
		pause = min(2*pause, heldFileRetryLongestPause)
	}
	return err
}

func renameReplacing(source string, target string) error {
	return retriedWhileHeld(func() error { return os.Rename(source, target) }, true)
}

func renameUnlessMissing(source string, target string) error {
	return retriedWhileHeld(func() error { return os.Rename(source, target) }, false)
}

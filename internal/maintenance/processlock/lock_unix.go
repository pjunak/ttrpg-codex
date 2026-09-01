//go:build !windows

package processlock

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

func tryLock(file *os.File, exclusive bool) error {
	operation := unix.LOCK_SH | unix.LOCK_NB
	if exclusive {
		operation = unix.LOCK_EX | unix.LOCK_NB
	}
	return unix.Flock(int(file.Fd()), operation)
}

func unlock(file *os.File) error {
	return unix.Flock(int(file.Fd()), unix.LOCK_UN)
}

func isLockConflict(err error) bool {
	return errors.Is(err, unix.EWOULDBLOCK) || errors.Is(err, unix.EAGAIN)
}

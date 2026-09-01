//go:build windows

package processlock

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

func tryLock(file *os.File, exclusive bool) error {
	flags := uint32(windows.LOCKFILE_FAIL_IMMEDIATELY)
	if exclusive {
		flags |= windows.LOCKFILE_EXCLUSIVE_LOCK
	}
	return windows.LockFileEx(
		windows.Handle(file.Fd()),
		flags,
		0, 1, 0, &windows.Overlapped{},
	)
}

func unlock(file *os.File) error {
	return windows.UnlockFileEx(windows.Handle(file.Fd()), 0, 1, 0, &windows.Overlapped{})
}

func isLockConflict(err error) bool {
	return errors.Is(err, windows.ERROR_LOCK_VIOLATION) || errors.Is(err, windows.ERROR_SHARING_VIOLATION)
}

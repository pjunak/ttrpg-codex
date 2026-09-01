package processlock

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

var ErrAlreadyLocked = errors.New("data directory is already in use")

type Lock struct {
	files []*os.File
}

func AcquireHost(directory string) (*Lock, error) {
	return acquire(directory, false, true)
}

func AcquireBackup(directory string) (*Lock, error) {
	return acquire(directory, false, false)
}

func AcquireRestore(directory string) (*Lock, error) {
	return acquire(directory, true, false)
}

func acquire(directory string, exclusiveGate, hostIdentity bool) (*Lock, error) {
	if directory == "" {
		return nil, fmt.Errorf("data directory is required")
	}
	absolute, err := filepath.Abs(directory)
	if err != nil {
		return nil, fmt.Errorf("resolve data directory: %w", err)
	}
	if filepath.Dir(absolute) == absolute {
		return nil, fmt.Errorf("data directory cannot be a filesystem root")
	}
	if err := os.MkdirAll(filepath.Dir(absolute), 0o750); err != nil {
		return nil, fmt.Errorf("create data directory parent: %w", err)
	}
	parent := filepath.Dir(absolute)
	base := filepath.Base(absolute)
	lock, err := acquireFile(filepath.Join(parent, "."+base+".codex.lock"), exclusiveGate)
	if err != nil {
		return nil, err
	}
	result := &Lock{files: []*os.File{lock}}
	if hostIdentity {
		hostLock, err := acquireFile(filepath.Join(parent, "."+base+".codex.host.lock"), true)
		if err != nil {
			_ = result.Close()
			return nil, err
		}
		result.files = append(result.files, hostLock)
	}
	return result, nil
}

func acquireFile(filename string, exclusive bool) (*os.File, error) {
	file, err := os.OpenFile(filename, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open data directory lock: %w", err)
	}
	if err := tryLock(file, exclusive); err != nil {
		_ = file.Close()
		if isLockConflict(err) {
			return nil, ErrAlreadyLocked
		}
		return nil, fmt.Errorf("lock data directory: %w", err)
	}
	return file, nil
}

func (lock *Lock) Close() error {
	if lock == nil {
		return nil
	}
	files := lock.files
	lock.files = nil
	errorsSeen := make([]error, 0, len(files)*2)
	for index := len(files) - 1; index >= 0; index-- {
		errorsSeen = append(errorsSeen, unlock(files[index]), files[index].Close())
	}
	return errors.Join(errorsSeen...)
}

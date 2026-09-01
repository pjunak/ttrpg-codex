package processlock

import (
	"errors"
	"testing"
)

func TestAcquireExcludesAnotherProcessOwnerUntilClose(t *testing.T) {
	directory := t.TempDir()
	first, err := AcquireRestore(directory)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := AcquireRestore(directory); !errors.Is(err, ErrAlreadyLocked) {
		t.Fatalf("second acquire error = %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	second, err := AcquireRestore(directory)
	if err != nil {
		t.Fatal(err)
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestHostAndBackupShareGateButSecondHostAndRestoreAreExcluded(t *testing.T) {
	directory := t.TempDir()
	host, err := AcquireHost(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()
	backup, err := AcquireBackup(directory)
	if err != nil {
		t.Fatalf("backup lock with host = %v", err)
	}
	defer backup.Close()
	if _, err := AcquireHost(directory); !errors.Is(err, ErrAlreadyLocked) {
		t.Fatalf("second host error = %v", err)
	}
	if _, err := AcquireRestore(directory); !errors.Is(err, ErrAlreadyLocked) {
		t.Fatalf("restore with host error = %v", err)
	}
}

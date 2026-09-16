// Package unitofwork composes host-owned stores inside one SQLite transaction.
// Add-ons cannot create a unit or supply its context.
package unitofwork

import (
	"context"
	"database/sql"
	"errors"
)

type key struct{}
type unit struct {
	db     *sql.DB
	tx     *sql.Tx
	notify []func()
}

// Run commits all participating writes before publishing any invalidation.
func Run(ctx context.Context, db *sql.DB, apply func(context.Context, *sql.Tx) error) error {
	if ctx.Value(key{}) != nil {
		return errors.New("nested host transactions are forbidden")
	}
	tx, err := db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	owner := &unit{db: db, tx: tx}
	if err = apply(context.WithValue(ctx, key{}, owner), tx); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	for _, notify := range owner.notify {
		notify()
	}
	return nil
}

// Begin joins only the exact database owned by Run. The cleanup function rolls
// back standalone transactions; the composing caller owns rollback otherwise.
func Begin(ctx context.Context, db *sql.DB) (*sql.Tx, func(), error) {
	if owner, ok := ctx.Value(key{}).(*unit); ok {
		if owner.db != db {
			return nil, func() {}, errors.New("host transaction cannot cross databases")
		}
		return owner.tx, func() {}, nil
	}
	tx, err := db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return nil, func() {}, err
	}
	return tx, func() { _ = tx.Rollback() }, nil
}
func Commit(ctx context.Context, tx *sql.Tx, notify func()) error {
	if owner, ok := ctx.Value(key{}).(*unit); ok {
		if owner.tx != tx {
			return errors.New("host transaction identity mismatch")
		}
		owner.notify = append(owner.notify, notify)
		return nil
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	notify()
	return nil
}

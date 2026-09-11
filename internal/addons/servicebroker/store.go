package servicebroker

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path"
	"sort"
	"strings"
	"time"
	"unicode"

	semver "github.com/Masterminds/semver/v3"
)

type Store struct {
	db  *sql.DB
	now func() time.Time
}

func NewStore(db *sql.DB) (*Store, error) {
	if db == nil {
		return nil, errors.New("service broker database is required")
	}
	return &Store{db: db, now: time.Now}, nil
}

func (store *Store) replaceProviders(
	ctx context.Context,
	addonID string,
	addonVersion string,
	declarations []ProviderDeclaration,
) error {
	if store == nil || store.db == nil {
		return errors.New("service broker store is required")
	}
	if err := validateAddonID(addonID); err != nil {
		return err
	}
	if _, err := semver.StrictNewVersion(addonVersion); err != nil {
		return fmt.Errorf("%w: invalid add-on version %q: %v", ErrInvalidDeclaration, addonVersion, err)
	}
	seen := make(map[string]struct{}, len(declarations))
	parsed := make(map[string]*semver.Version, len(declarations))
	for _, declaration := range declarations {
		version, err := validateProviderDeclaration(declaration)
		if err != nil {
			return err
		}
		if _, exists := seen[declaration.Contract]; exists {
			return fmt.Errorf("%w: duplicate contract %q", ErrInvalidDeclaration, declaration.Contract)
		}
		seen[declaration.Contract] = struct{}{}
		parsed[declaration.Contract] = version
	}

	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin provider replacement: %w", err)
	}
	defer tx.Rollback()
	if err := checkExclusiveConflicts(ctx, tx, addonID, declarations, parsed); err != nil {
		return err
	}

	updatedAt := store.now().UTC().Format(time.RFC3339Nano)
	revision, err := advanceCatalog(ctx, tx, addonID, addonVersion, updatedAt)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM addon_service_providers WHERE addon_id = ?`, addonID); err != nil {
		return fmt.Errorf("remove previous service providers: %w", err)
	}
	for _, declaration := range declarations {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO addon_service_providers(
				addon_id, contract, addon_version, contract_version, transport,
				schema_path, exclusive, catalog_revision, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			addonID,
			declaration.Contract,
			addonVersion,
			declaration.Version,
			string(declaration.Transport),
			declaration.Schema,
			declaration.Exclusive,
			revision,
			updatedAt,
		); err != nil {
			return fmt.Errorf("insert service provider %s: %w", declaration.Contract, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit provider replacement: %w", err)
	}
	return nil
}

func (store *Store) removeProviders(ctx context.Context, addonID string) error {
	if err := validateAddonID(addonID); err != nil {
		return err
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin service provider removal: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `
		UPDATE addon_service_catalogs
		SET revision = revision + 1, installed = 0, updated_at = ?
		WHERE addon_id = ?`,
		store.now().UTC().Format(time.RFC3339Nano),
		addonID,
	); err != nil {
		return fmt.Errorf("retire service provider catalog: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM addon_service_providers WHERE addon_id = ?`, addonID); err != nil {
		return fmt.Errorf("remove service providers: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit service provider removal: %w", err)
	}
	return nil
}

func (store *Store) listProviders(ctx context.Context, contract string) ([]Provider, error) {
	if err := validateContract(contract); err != nil {
		return nil, err
	}
	rows, err := store.db.QueryContext(ctx, `
		SELECT addon_id, addon_version, contract, contract_version, transport,
		       schema_path, exclusive, catalog_revision, updated_at
		FROM addon_service_providers
		WHERE contract = ?
		ORDER BY addon_id`, contract)
	if err != nil {
		return nil, fmt.Errorf("list service providers: %w", err)
	}
	defer rows.Close()

	providers := make([]Provider, 0)
	for rows.Next() {
		provider, err := scanProvider(rows)
		if err != nil {
			return nil, err
		}
		providers = append(providers, provider)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate service providers: %w", err)
	}
	return providers, nil
}

func (store *Store) listAddonProviders(ctx context.Context, addonID string) ([]Provider, error) {
	if err := validateAddonID(addonID); err != nil {
		return nil, err
	}
	rows, err := store.db.QueryContext(ctx, `
		SELECT addon_id, addon_version, contract, contract_version, transport,
		       schema_path, exclusive, catalog_revision, updated_at
		FROM addon_service_providers
		WHERE addon_id = ?
		ORDER BY contract`, addonID)
	if err != nil {
		return nil, fmt.Errorf("list add-on service providers: %w", err)
	}
	defer rows.Close()

	providers := make([]Provider, 0)
	for rows.Next() {
		provider, err := scanProvider(rows)
		if err != nil {
			return nil, err
		}
		providers = append(providers, provider)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate add-on service providers: %w", err)
	}
	return providers, nil
}

func (store *Store) setBinding(
	ctx context.Context,
	requirement Requirement,
	providerAddonIDs []string,
	expectedRevision int64,
) (Binding, error) {
	constraint, err := validateRequirement(requirement)
	if err != nil {
		return Binding{}, err
	}
	if requirement.Selection != SelectionOperator {
		return Binding{}, fmt.Errorf("%w: all-compatible requirements do not have operator bindings", ErrInvalidSelection)
	}
	providerAddonIDs, err = normalizedTargets(providerAddonIDs, requirement.Cardinality)
	if err != nil {
		return Binding{}, err
	}
	if expectedRevision < 0 {
		return Binding{}, fmt.Errorf("%w: expected revision cannot be negative", ErrBindingConflict)
	}

	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return Binding{}, fmt.Errorf("begin service binding update: %w", err)
	}
	defer tx.Rollback()
	for _, providerAddonID := range providerAddonIDs {
		if providerAddonID == requirement.ConsumerAddonID {
			return Binding{}, fmt.Errorf("%w: a consumer cannot bind to itself", ErrInvalidSelection)
		}
		provider, err := providerForSelection(ctx, tx, providerAddonID, requirement.Contract)
		if err != nil {
			return Binding{}, err
		}
		version, err := semver.StrictNewVersion(provider.ContractVersion)
		if err != nil || !constraint.Check(version) {
			return Binding{}, fmt.Errorf("%w: provider %s offers incompatible version %s", ErrInvalidSelection, providerAddonID, provider.ContractVersion)
		}
	}

	now := store.now().UTC()
	revision := int64(1)
	if expectedRevision == 0 {
		result, err := tx.ExecContext(ctx, `
			INSERT INTO addon_service_bindings(
				consumer_addon_id, contract, scope_kind, scope_id, revision, updated_at
			) VALUES (?, ?, ?, ?, 1, ?)
			ON CONFLICT(consumer_addon_id, contract, scope_kind, scope_id) DO NOTHING`,
			requirement.ConsumerAddonID,
			requirement.Contract,
			requirement.Scope.Kind,
			requirement.Scope.ID,
			now.Format(time.RFC3339Nano),
		)
		if err != nil {
			return Binding{}, fmt.Errorf("create service binding: %w", err)
		}
		if err := requireChanged(result, ErrBindingConflict); err != nil {
			return Binding{}, err
		}
	} else {
		revision = expectedRevision + 1
		result, err := tx.ExecContext(ctx, `
			UPDATE addon_service_bindings
			SET revision = ?, updated_at = ?
			WHERE consumer_addon_id = ? AND contract = ? AND scope_kind = ? AND scope_id = ?
			  AND revision = ?`,
			revision,
			now.Format(time.RFC3339Nano),
			requirement.ConsumerAddonID,
			requirement.Contract,
			requirement.Scope.Kind,
			requirement.Scope.ID,
			expectedRevision,
		)
		if err != nil {
			return Binding{}, fmt.Errorf("update service binding: %w", err)
		}
		if err := requireChanged(result, ErrBindingConflict); err != nil {
			return Binding{}, err
		}
	}
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM addon_service_binding_targets
		WHERE consumer_addon_id = ? AND contract = ? AND scope_kind = ? AND scope_id = ?`,
		requirement.ConsumerAddonID,
		requirement.Contract,
		requirement.Scope.Kind,
		requirement.Scope.ID,
	); err != nil {
		return Binding{}, fmt.Errorf("replace service binding targets: %w", err)
	}
	for _, providerAddonID := range providerAddonIDs {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO addon_service_binding_targets(
				consumer_addon_id, contract, scope_kind, scope_id, provider_addon_id
			) VALUES (?, ?, ?, ?, ?)`,
			requirement.ConsumerAddonID,
			requirement.Contract,
			requirement.Scope.Kind,
			requirement.Scope.ID,
			providerAddonID,
		); err != nil {
			return Binding{}, fmt.Errorf("insert service binding target: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE addon_instance_configuration SET revision = revision + 1 WHERE id = 1`); err != nil {
		return Binding{}, err
	}
	if err := tx.Commit(); err != nil {
		return Binding{}, fmt.Errorf("commit service binding update: %w", err)
	}
	return Binding{
		ConsumerAddonID:  requirement.ConsumerAddonID,
		Contract:         requirement.Contract,
		Scope:            requirement.Scope,
		ProviderAddonIDs: append([]string(nil), providerAddonIDs...),
		Revision:         revision,
		UpdatedAt:        now,
	}, nil
}

func (store *Store) clearBinding(ctx context.Context, requirement Requirement, expectedRevision int64) error {
	if _, err := validateRequirement(requirement); err != nil {
		return err
	}
	if expectedRevision <= 0 {
		return fmt.Errorf("%w: a positive expected revision is required", ErrBindingConflict)
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `
		DELETE FROM addon_service_bindings
		WHERE consumer_addon_id = ? AND contract = ? AND scope_kind = ? AND scope_id = ?
		  AND revision = ?`,
		requirement.ConsumerAddonID,
		requirement.Contract,
		requirement.Scope.Kind,
		requirement.Scope.ID,
		expectedRevision,
	)
	if err != nil {
		return fmt.Errorf("clear service binding: %w", err)
	}
	if err := requireChanged(result, ErrBindingConflict); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE addon_instance_configuration SET revision = revision + 1 WHERE id = 1`); err != nil {
		return err
	}
	return tx.Commit()
}

func (store *Store) readBinding(ctx context.Context, requirement Requirement) (*Binding, error) {
	if _, err := validateRequirement(requirement); err != nil {
		return nil, err
	}
	rows, err := store.db.QueryContext(ctx, `
		SELECT binding.revision, binding.updated_at, target.provider_addon_id
		FROM addon_service_bindings AS binding
		LEFT JOIN addon_service_binding_targets AS target
		  ON target.consumer_addon_id = binding.consumer_addon_id
		 AND target.contract = binding.contract
		 AND target.scope_kind = binding.scope_kind
		 AND target.scope_id = binding.scope_id
		WHERE binding.consumer_addon_id = ? AND binding.contract = ?
		  AND binding.scope_kind = ? AND binding.scope_id = ?
		ORDER BY target.provider_addon_id`,
		requirement.ConsumerAddonID,
		requirement.Contract,
		requirement.Scope.Kind,
		requirement.Scope.ID,
	)
	if err != nil {
		return nil, fmt.Errorf("read service binding: %w", err)
	}
	defer rows.Close()
	var revision int64
	var updatedAtText string
	targets := make([]string, 0)
	for rows.Next() {
		var target sql.NullString
		if err := rows.Scan(&revision, &updatedAtText, &target); err != nil {
			return nil, fmt.Errorf("scan service binding: %w", err)
		}
		if target.Valid {
			targets = append(targets, target.String)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate service binding: %w", err)
	}
	if revision == 0 {
		return nil, nil
	}
	updatedAt, err := time.Parse(time.RFC3339Nano, updatedAtText)
	if err != nil {
		return nil, fmt.Errorf("parse service binding updated_at: %w", err)
	}
	return &Binding{
		ConsumerAddonID:  requirement.ConsumerAddonID,
		Contract:         requirement.Contract,
		Scope:            requirement.Scope,
		ProviderAddonIDs: targets,
		Revision:         revision,
		UpdatedAt:        updatedAt,
	}, nil
}

func checkExclusiveConflicts(
	ctx context.Context,
	tx *sql.Tx,
	addonID string,
	declarations []ProviderDeclaration,
	parsed map[string]*semver.Version,
) error {
	if len(declarations) == 0 {
		return nil
	}
	byContract := make(map[string]ProviderDeclaration, len(declarations))
	for _, declaration := range declarations {
		byContract[declaration.Contract] = declaration
	}
	rows, err := tx.QueryContext(ctx, `
		SELECT addon_id, contract, contract_version, exclusive
		FROM addon_service_providers
		WHERE addon_id <> ?
		ORDER BY contract, addon_id`, addonID)
	if err != nil {
		return fmt.Errorf("inspect exclusive providers: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var existingAddonID, contract, rawVersion string
		var exclusive bool
		if err := rows.Scan(&existingAddonID, &contract, &rawVersion, &exclusive); err != nil {
			return fmt.Errorf("scan exclusive provider: %w", err)
		}
		declaration, relevant := byContract[contract]
		if !relevant || (!declaration.Exclusive && !exclusive) {
			continue
		}
		existingVersion, err := semver.StrictNewVersion(rawVersion)
		if err != nil {
			return fmt.Errorf("stored provider %s has invalid contract version %q: %w", existingAddonID, rawVersion, err)
		}
		if existingVersion.Major() == parsed[contract].Major() {
			return fmt.Errorf("%w: %s and %s both provide %s major %d", ErrExclusiveConflict, existingAddonID, addonID, contract, existingVersion.Major())
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate exclusive providers: %w", err)
	}
	return nil
}

func advanceCatalog(
	ctx context.Context,
	tx *sql.Tx,
	addonID string,
	addonVersion string,
	updatedAt string,
) (int64, error) {
	row := tx.QueryRowContext(ctx, `
		INSERT INTO addon_service_catalogs(addon_id, addon_version, revision, installed, updated_at)
		VALUES (?, ?, 1, 1, ?)
		ON CONFLICT(addon_id) DO UPDATE SET
			addon_version = excluded.addon_version,
			revision = addon_service_catalogs.revision + 1,
			installed = 1,
			updated_at = excluded.updated_at
		RETURNING revision`,
		addonID,
		addonVersion,
		updatedAt,
	)
	var revision int64
	if err := row.Scan(&revision); err != nil {
		return 0, fmt.Errorf("advance service provider catalog: %w", err)
	}
	return revision, nil
}

type rowScanner interface {
	Scan(...any) error
}

func scanProvider(row rowScanner) (Provider, error) {
	var provider Provider
	var exclusive bool
	var updatedAtText string
	if err := row.Scan(
		&provider.AddonID,
		&provider.AddonVersion,
		&provider.Contract,
		&provider.ContractVersion,
		&provider.Transport,
		&provider.Schema,
		&exclusive,
		&provider.CatalogRevision,
		&updatedAtText,
	); err != nil {
		return Provider{}, fmt.Errorf("scan service provider: %w", err)
	}
	provider.Exclusive = exclusive
	updatedAt, err := time.Parse(time.RFC3339Nano, updatedAtText)
	if err != nil {
		return Provider{}, fmt.Errorf("parse service provider updated_at: %w", err)
	}
	provider.UpdatedAt = updatedAt
	return provider, nil
}

func providerForSelection(ctx context.Context, tx *sql.Tx, addonID, contract string) (Provider, error) {
	row := tx.QueryRowContext(ctx, `
		SELECT addon_id, addon_version, contract, contract_version, transport,
		       schema_path, exclusive, catalog_revision, updated_at
		FROM addon_service_providers
		WHERE addon_id = ? AND contract = ?`, addonID, contract)
	provider, err := scanProvider(row)
	if err != nil {
		if errors.Is(rootError(err), sql.ErrNoRows) {
			return Provider{}, fmt.Errorf("%w: %s does not provide %s", ErrInvalidSelection, addonID, contract)
		}
		return Provider{}, err
	}
	return provider, nil
}

func validateProviderDeclaration(declaration ProviderDeclaration) (*semver.Version, error) {
	if err := validateContract(declaration.Contract); err != nil {
		return nil, err
	}
	version, err := semver.StrictNewVersion(declaration.Version)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid contract version %q: %v", ErrInvalidDeclaration, declaration.Version, err)
	}
	if declaration.Transport != TransportUI && declaration.Transport != TransportWorker && declaration.Transport != TransportContent {
		return nil, fmt.Errorf("%w: invalid transport %q", ErrInvalidDeclaration, declaration.Transport)
	}
	if !validPackagePath(declaration.Schema) {
		return nil, fmt.Errorf("%w: invalid service schema path", ErrInvalidDeclaration)
	}
	return version, nil
}

func validateRequirement(requirement Requirement) (*semver.Constraints, error) {
	if err := validateAddonID(requirement.ConsumerAddonID); err != nil {
		return nil, err
	}
	if err := validateContract(requirement.Contract); err != nil {
		return nil, err
	}
	if requirement.Range == "" || len(requirement.Range) > 100 {
		return nil, fmt.Errorf("%w: invalid service version range", ErrInvalidDeclaration)
	}
	constraint, err := semver.NewConstraint(requirement.Range)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid service version range %q: %v", ErrInvalidDeclaration, requirement.Range, err)
	}
	if requirement.Cardinality != CardinalityOne && requirement.Cardinality != CardinalityMany {
		return nil, fmt.Errorf("%w: invalid cardinality %q", ErrInvalidDeclaration, requirement.Cardinality)
	}
	if requirement.Selection != SelectionOperator && requirement.Selection != SelectionAllCompatible {
		return nil, fmt.Errorf("%w: invalid selection policy %q", ErrInvalidDeclaration, requirement.Selection)
	}
	if requirement.Cardinality == CardinalityOne && requirement.Selection != SelectionOperator {
		return nil, fmt.Errorf("%w: cardinality one requires operator selection policy", ErrInvalidDeclaration)
	}
	if err := validateScope(requirement.Scope); err != nil {
		return nil, err
	}
	return constraint, nil
}

func validateAddonID(value string) error {
	if len(value) > 80 || !addonIDPattern.MatchString(value) {
		return fmt.Errorf("%w: invalid add-on ID %q", ErrInvalidDeclaration, value)
	}
	return nil
}

func validateContract(value string) error {
	if len(value) > 120 || !contractPattern.MatchString(value) {
		return fmt.Errorf("%w: invalid service contract %q", ErrInvalidDeclaration, value)
	}
	return nil
}

func validateScope(scope Scope) error {
	if len(scope.Kind) > 100 || !scopeKindPattern.MatchString(scope.Kind) {
		return fmt.Errorf("%w: invalid service scope kind %q", ErrInvalidDeclaration, scope.Kind)
	}
	if scope.Kind == "global" {
		if scope.ID != "" {
			return fmt.Errorf("%w: global service scope cannot have an ID", ErrInvalidDeclaration)
		}
		return nil
	}
	if scope.ID == "" || len(scope.ID) > 200 || hasControl(scope.ID) {
		return fmt.Errorf("%w: non-global service scope requires an ID", ErrInvalidDeclaration)
	}
	return nil
}

func normalizedTargets(values []string, cardinality Cardinality) ([]string, error) {
	result := append([]string(nil), values...)
	sort.Strings(result)
	for index, value := range result {
		if err := validateAddonID(value); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrInvalidSelection, err)
		}
		if index > 0 && result[index-1] == value {
			return nil, fmt.Errorf("%w: duplicate provider %s", ErrInvalidSelection, value)
		}
	}
	if cardinality == CardinalityOne && len(result) > 1 {
		return nil, fmt.Errorf("%w: cardinality one accepts at most one provider", ErrInvalidSelection)
	}
	return result, nil
}

func validPackagePath(value string) bool {
	if value == "" || len(value) > 500 || strings.Contains(value, "\\") ||
		strings.HasPrefix(value, "/") || hasControl(value) || path.Clean(value) != value {
		return false
	}
	first, _, _ := strings.Cut(value, "/")
	return !strings.Contains(first, ":") && value != "." && value != ".." && !strings.HasPrefix(value, "../")
}

func hasControl(value string) bool {
	for _, character := range value {
		if unicode.IsControl(character) {
			return true
		}
	}
	return false
}

func requireChanged(result sql.Result, sentinel error) error {
	count, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("read affected rows: %w", err)
	}
	if count != 1 {
		return sentinel
	}
	return nil
}

func rootError(err error) error {
	for {
		next := errors.Unwrap(err)
		if next == nil {
			return err
		}
		err = next
	}
}

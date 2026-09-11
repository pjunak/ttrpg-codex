# Instance rules, sourcebooks and service providers

This specification implements F07 and F08 in the current package, content and
service architecture. Each website instance uses one ruleset. Books may come
from several independent add-ons, and each add-on may contain several books.
Campaign data and authored character choices are separate from these settings.

## Ruleset compatibility

A package containing the complete rules profile establishes the instance
ruleset on its first successful activation. The manifest declares:

```json
"rules": {
  "supports": ["dnd-2024"],
  "defines": {
    "id": "dnd-2024",
    "name": "D&D 5.5e (2024)",
    "contract": "dnd5e.rules-data",
    "contentSet": "rules",
    "recordKind": "ruleset",
    "recordId": "dnd-2024"
  }
}
```

Inspection verifies that the profile record and content service exist and that
the defining package supports its own ruleset. The host does not implement D&D
constants: the engine validates the complete profile's domain schema.

Additional sources declare `rules.supports`, without `defines`. For example,
`["dnd-2014", "dnd-2024"]` explicitly supports both 5e and 5.5e. Matching uses
stable IDs, never display labels, edition guesses, file names or package IDs.
The host rejects activation of incompatible declarations and undeclared
providers of the instance's rules-data contract. Activating the first defining
package also checks already active rules-aware packages. Other add-ons need
no rules declaration. A headless optional consumer can run before rules exist;
additional source packages require an established ruleset.

Disabling the defining package retains the instance ruleset. A different
complete-profile package can replace it only after the previous defining
package is disabled and only for the same ruleset ID and content contract.
An instance cannot switch to another ruleset through source/provider settings.
There is no legacy startup path, campaign conversion or reset operation here.

## Source selection

Settings → Add-ons displays the ruleset and groups sourcebook checkboxes by
package. The shared catalog derives membership from each content set's declared
`groups.field` and optional `groups.additionalField`; dotted field paths are
supported. Optional `groups.catalogKind` identifies book metadata records,
whose stable IDs and names label the choices. No book IDs are hard-coded.

- Sources containing the complete rules profile establish the initial usable
  base. A sole profile source is required; alternative profile memberships
  require at least one selected source.
- Optional sources initially stay disabled and visibly pending review. Package
  activation review lists the books that will be off. Source settings require
  an explicit review and Apply action, including a decision to keep books off.
- Choices persist by `(addonId, setId, sourceId)` across updates, disable and
  restart. Newly added source IDs remain pending; inactive package selections
  are retained. Applying an unchanged reviewed policy does not restart add-ons.
- A record with several source memberships is eligible when any member is
  enabled. Ungrouped metadata remains available. Book metadata itself follows
  its book's selection. Empty effective content sets are valid.
- Browsing, exact record retrieval and worker content services all use the same
  effective index. A browse facet cannot bypass the instance's source policy.

The index remains immutable; changing policy creates a filtered view. Effective
revisions include the archive identity, declared content revision and enabled
sources. Cursors bind the content set, effective revision and query kind.
Content HTTP responses use `private, no-store`, because source eligibility can
change at the same archive URL. Generation-scoped clients also bypass old
immutable browser cache entries.

## Provider selection and lifecycle

Service settings show active and newest staged consumers, declared version
ranges, compatible and unavailable providers, current connections and stale
selections. A `one` consumer automatically uses the sole compatible active
provider. Several providers remain ambiguous until the operator chooses one.
The operator can explicitly select or return to Automatic. An unavailable
selected provider never silently changes to another provider.

`many` consumers declare either an operator-selected set or `all-compatible`.
The latter combines all compatible providers automatically and has no manual
override. Bindings belong to a consumer/contract/scope, so staged and active
versions of that consumer share the selection. Generic exclusive service
contracts still enforce their exclusivity; the compendium's rules-data service
is deliberately nonexclusive so independent compatible sources can coexist.

Admin GET/POST `/api/admin/rules-policy` and `/api/admin/service-selections`
reuse DM authorization and CSRF protection. Apply binds the configuration
revision and browser graph revision; provider changes additionally bind the
consumer generation and binding revision. Activation reviews include the
configuration revision and initial source choices. Stale reviews fail closed.
The UI keeps drafts after errors and offers explicit refresh and review.

Both settings reuse the manager's cold graph restart: stop consumers before
providers, persist the choice, then recover providers before consumers. The
review lists all running add-ons that will restart. If recovery fails, the
accepted choice stays visible with restart failures; there is no hidden
fallback. Browser graph revisions, worker bindings, effective content and
in-flight catalog epochs invalidate old runtime results together.

## Engine and character preservation

The behavior below describes the current implementation. The planned
[character decisions and history redesign](CHARACTER_BUILD_HISTORY.md) replaces
the manual/automatic sheet split with typed decisions, DM grants and retained
projections. It keeps this specification's one-ruleset policy, compatible source
selection and explicit adoption of changed rules. No runtime contract changes
merely because that plan has been documented.

The D&D engine consumes all compatible `dnd5e.rules-data` providers from its
host-issued worker bindings. It requires exactly one complete profile across
the combined catalog. Record identity remains `(kind, id)`; duplicate IDs
across sources fail with the conflicting providers identified. Names are
labels, so duplicate names remain usable by ID and ambiguous name-only lookups
stay unresolved. There is no arbitrary override order or ID rewriting.

The result identity names the complete-profile provider and, for multiple
providers, carries a content revision hashing every provider's identity,
generation and effective revision. Record envelopes include their owning
`providerAddonId`. Snapshot loading verifies the catalogs before publication;
cache checks still contact providers. Removing a source invalidates old cursors,
builder plans and computed snapshots without mutating previously returned data.

Changing sources or providers does not write character extensions, delete
decisions, erase snapshots or recalculate saved values. Existing values remain
usable when their source is unavailable. Equipment edits preserve manual
values and only refresh computed values when the complete saved identity still
matches. Changed or unverifiable saved provenance requires an explicit rules
preview and apply before rules actions can replace computed values. A preview
from a different rules snapshot cannot authorize the replacement.

**Data implications:** new optional books being off can make existing choices
unavailable for future selection. The choices and saved sheets remain stored.
Explicitly applying newly computed values can change derived statistics; the
sheet's existing preview/materialization contract governs that action. This
work does not inspect or modify live campaign data.

## UX and verification

Independent native checkboxes follow the [GOV.UK checkbox guidance](https://design-system.service.gov.uk/components/checkboxes/).
The detached review names changes and restart effects, following the
[check answers pattern](https://design-system.service.gov.uk/patterns/check-answers/).
Failed requests preserve choices, following [validation guidance](https://design-system.service.gov.uk/patterns/validation/).
Controls use existing design tokens, keyboard-accessible native inputs,
English/Czech messages and bounded responsive layouts.

Regression coverage lives in the content filter/cursor, package configuration,
service broker and engine provider tests. Installed browser fixtures exercise
review, conflict recovery, source retrieval, provider override/clear, DM/CSRF
boundaries and desktop/phone layouts through a disposable host. Full companion
package fixtures explicitly enable their reference corpus; ordinary
installation retains the production pending-source default.

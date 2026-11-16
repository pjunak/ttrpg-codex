# Publish a tested add-on

Use this composite action at an immutable host commit in a separate main-only
job with `needs: test` and `permissions: { contents: write }`. The test job must
build the package, pass its complete checks and host inspection, then upload
exactly one ZIP as the `reviewed-package` artifact. `artifact` can override that
name. Do not grant write permissions to pull-request test jobs.

Language packs are optional. When the test job builds them with
`codex-addon-inspect -build-packs`, it uploads them as a second artifact and
names it in `packs-artifact`. Every file there must be
`<package file name without .zip>.<locale>.langpack.zip`; the action uploads
them beside the package, package first, and lists them in the release notes.
Without `packs-artifact` nothing changes.

The action downloads the same run's artifact and uses the automatic repository
`GITHUB_TOKEN`. It needs no personal token, source checkout or server credentials.
Keep publication serialized in the caller so concurrent runs cannot race the
latest release pointer. Main builds should not cancel an in-progress publish.

The action creates `build-<full SHA>`, verifies every uploaded ZIP digest, and
then publishes the draft. An existing identical release is reused; different
bytes, extra assets or a conflicting tag are rejected. Older tested commits do not replace a newer
latest release. Failed drafts can be retried from the same workflow; inspect an
uncertain publication before rerunning. Published packages are never overwritten.
Private repositories retain private releases. No installation is updated here.

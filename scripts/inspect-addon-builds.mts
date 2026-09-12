import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hostRoot = fileURLToPath(new URL('../', import.meta.url));

export function builtAddonArchive(repository: string): string {
  const root = resolve(repository);
  const manifest: unknown = JSON.parse(readFileSync(join(root, 'addon.json'), 'utf8'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`Invalid add-on manifest in ${root}`);
  }
  const { id, version } = manifest as Record<string, unknown>;
  // These values select a filename; the host inspector validates the complete manifest.
  if (typeof id !== 'string' || typeof version !== 'string' ||
      !/^[a-z][a-z0-9-]*$/.test(id) || !/^[0-9][a-zA-Z0-9.+-]*$/.test(version)) {
    throw new Error(`Invalid add-on package identity in ${root}`);
  }
  const archive = join(root, 'dist', `${id}-${version}.zip`);
  if (!statSync(archive, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Build the current add-on package before inspection: ${archive}`);
  }
  return archive;
}

export function inspectAddonBuilds(
  repositories: readonly string[],
  inspect: (archive: string) => void = archive => {
    const result = spawnSync('go', ['run', './cmd/codex-addon-inspect', '-compact', archive],
      { cwd: hostRoot, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Add-on inspection failed: ${archive}`);
  },
): void {
  if (!repositories.length) throw new Error('Usage: node scripts/inspect-addon-builds.mts <addon-repository> [...]');
  const archives = repositories.map(builtAddonArchive);
  for (const archive of archives) inspect(archive);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    inspectAddonBuilds(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

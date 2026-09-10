import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/').replace(/\/$/, '')}`,
  'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true }).split('\0');
const javascript = files.filter(path => /\.(?:[cm]?js|jsx)$/i.test(path) && existsSync(resolve(root, path)));
if (javascript.length > 0) {
  console.error(`Author repository code in TypeScript. JavaScript source found:\n${javascript.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('Source language check passed: no JavaScript source files.');
}

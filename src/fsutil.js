import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** Recursively collect files matching a predicate, skipping noise directories. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', 'dist', 'build', '__pycache__']);

export async function collectFiles(root, predicate) {
  const found = [];
  const stack = [root];

  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full);
      } else if (entry.isFile() && predicate(full)) {
        found.push(full);
      }
    }
  }

  return found.sort();
}

export function isToml(filePath) {
  return path.extname(filePath).toLowerCase() === '.toml';
}

/** Read a file as UTF-8, stripping a BOM if the editor added one. */
export async function readText(filePath) {
  const raw = await fsp.readFile(filePath, 'utf8');
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

export function writeTextSync(filePath, text) {
  fs.writeFileSync(filePath, text, 'utf8');
}

/** Output filename for a source TOML, preserving subdirectory structure. */
export function outputNameFor(sourcePath, rootDir, ext = '.ndjson') {
  const rel = path.relative(rootDir, sourcePath);
  const parsed = path.parse(rel);
  return path.join(parsed.dir, `${parsed.name}${ext}`);
}

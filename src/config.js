/**
 * Overwrite protection and the config file.
 *
 * Two separate concerns that both exist to stop a user from losing work:
 *  - `shouldWrite` decides whether an existing file may be replaced.
 *  - `loadConfig` / `writeConfig` handle rulepress.config.json.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const CONFIG_NAME = 'rulepress.config.json';

export const CONFIG_TEMPLATE = {
  $schema: 'https://raw.githubusercontent.com/TuanCui22/rulepress/master/rulepress.config.schema.json',
  out: 'ndjson',
  bundle: null,
  strict: false,
  quiet: false,
  skip: ['node_modules', '.git', 'dist', 'build'],
};

/** Where the config file lives for a given working directory. */
export function configPathFor(cwd = process.cwd()) {
  return path.join(cwd, CONFIG_NAME);
}

/**
 * Read rulepress.config.json from cwd.
 * Returns { config, found, path, error }.
 * A malformed config is an error the caller must surface, not silently ignore.
 */
export async function loadConfig(cwd = process.cwd()) {
  const file = configPathFor(cwd);
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    return { config: {}, found: false, path: file, error: null };
  }
  try {
    const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { config: {}, found: true, path: file, error: 'config must be a JSON object' };
    }
    return { config: parsed, found: true, path: file, error: null };
  } catch (error) {
    return { config: {}, found: true, path: file, error: `config is not valid JSON: ${error.message}` };
  }
}

/**
 * Write the template config. Refuses to clobber an existing file unless forced.
 * Returns { ok, path, reason }.
 */
export async function writeConfig(cwd = process.cwd(), { force = false } = {}) {
  const file = configPathFor(cwd);
  if (fs.existsSync(file) && !force) {
    return { ok: false, path: file, reason: 'already exists' };
  }
  await fsp.writeFile(file, `${JSON.stringify(CONFIG_TEMPLATE, null, 2)}\n`, 'utf8');
  return { ok: true, path: file, reason: null };
}

/**
 * Decide whether writing `target` is allowed.
 *
 * Modes:
 *   force    - always allowed
 *   dryRun   - never writes, so always "allowed" (nothing happens)
 *   default  - allowed only if the file does not exist yet
 *
 * Returns { allowed, reason }.
 */
export function shouldWrite(target, { force = false, dryRun = false } = {}) {
  if (dryRun) return { allowed: true, reason: null };
  if (force) return { allowed: true, reason: null };
  if (!fs.existsSync(target)) return { allowed: true, reason: null };
  return { allowed: false, reason: 'exists' };
}

/**
 * Collect every target that would be overwritten, so the CLI can warn once
 * before writing anything rather than failing halfway through.
 */
export function findOverwrites(targets) {
  return targets.filter((t) => fs.existsSync(t));
}

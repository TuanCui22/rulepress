import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseArgs, suggestFlag } from '../src/cli.js';
import { checkNodeVersion, majorOf, MIN_MAJOR } from '../src/nodecheck.js';
import { openCommandFor, isInteractive } from '../src/platform.js';
import {
  shouldWrite,
  findOverwrites,
  loadConfig,
  writeConfig,
  configPathFor,
  CONFIG_NAME,
  CONFIG_TEMPLATE,
} from '../src/config.js';

// ---------------------------------------------------------------- parseArgs

test('parseArgs: new boolean flags are recognised', () => {
  const opts = parseArgs(['rules/', '--dry-run', '--force', '--watch', '--open', '--init']);
  assert.equal(opts.dryRun, true);
  assert.equal(opts.force, true);
  assert.equal(opts.watch, true);
  assert.equal(opts.open, true);
  assert.equal(opts.init, true);
  assert.deepEqual(opts.inputs, ['rules/']);
});

test('parseArgs: existing flags still work', () => {
  const opts = parseArgs(['a.toml', '-o', 'build', '--bundle', 'all.ndjson', '--strict', '--json', '-q']);
  assert.equal(opts.out, 'build');
  assert.equal(opts.bundle, 'all.ndjson');
  assert.equal(opts.strict, true);
  assert.equal(opts.json, true);
  assert.equal(opts.quiet, true);
});

test('parseArgs: value flag without a value throws with an example', () => {
  assert.throws(() => parseArgs(['--out']), (error) => {
    assert.match(error.message, /needs a value/);
    assert.match(error.message, /Example:/);
    return true;
  });
});

test('parseArgs: unknown flag throws and suggests the closest match', () => {
  assert.throws(() => parseArgs(['rules/', '--dry-runn']), (error) => {
    assert.match(error.message, /unknown option --dry-runn/);
    assert.match(error.message, /Did you mean --dry-run\?/);
    return true;
  });
});

test('parseArgs: --help and --version are booleans, not inputs', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-v']).version, true);
  assert.deepEqual(parseArgs(['--help']).inputs, []);
});

test('suggestFlag: returns null for something unrelated', () => {
  assert.equal(suggestFlag('--completely-different-thing'), null);
});

test('suggestFlag: maps a one-character typo', () => {
  assert.equal(suggestFlag('--forc'), '--force');
  assert.equal(suggestFlag('--bundl'), '--bundle');
});

// ---------------------------------------------------------------- nodecheck

test('majorOf: parses common version shapes', () => {
  assert.equal(majorOf('18.19.0'), 18);
  assert.equal(majorOf('v20.11.1'), 20);
  assert.equal(majorOf('22'), 22);
  assert.equal(majorOf('not-a-version'), null);
  assert.equal(majorOf(undefined), null);
});

test('checkNodeVersion: accepts the minimum and newer', () => {
  assert.equal(checkNodeVersion(`v${MIN_MAJOR}.0.0`).ok, true);
  assert.equal(checkNodeVersion('v22.1.0').ok, true);
});

test('checkNodeVersion: rejects older with actionable advice', () => {
  const result = checkNodeVersion('v16.20.0');
  assert.equal(result.ok, false);
  assert.match(result.message, /needs Node 18 or newer/);
  assert.match(result.message, /nodejs\.org/);
  assert.match(result.message, /nvm install/);
});

test('checkNodeVersion: rejects unparseable versions', () => {
  assert.equal(checkNodeVersion('weird').ok, false);
});

// ---------------------------------------------------------------- platform

test('openCommandFor: picks the right command per platform', () => {
  assert.equal(openCommandFor('/x', 'win32').command, 'explorer');
  assert.equal(openCommandFor('/x', 'darwin').command, 'open');
  assert.equal(openCommandFor('/x', 'linux').command, 'xdg-open');
});

test('openCommandFor: explorer exit code is ignored (it returns 1 on success)', () => {
  assert.equal(openCommandFor('/x', 'win32').ignoreExitCode, true);
  assert.equal(openCommandFor('/x', 'linux').ignoreExitCode, false);
});

test('openCommandFor: unknown platform returns null instead of guessing', () => {
  assert.equal(openCommandFor('/x', 'aix'), null);
});

test('isInteractive: false when streams are not TTYs', () => {
  assert.equal(isInteractive({ input: { isTTY: false }, output: { isTTY: true } }), false);
  assert.equal(isInteractive({ input: { isTTY: true }, output: { isTTY: true } }), true);
  assert.equal(isInteractive({ input: {}, output: {} }), false);
});

// ---------------------------------------------------------------- config

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rulepress-test-'));
}

test('shouldWrite: allows a new file', () => {
  const dir = tempDir();
  const target = path.join(dir, 'new.ndjson');
  assert.equal(shouldWrite(target).allowed, true);
});

test('shouldWrite: refuses an existing file without force', () => {
  const dir = tempDir();
  const target = path.join(dir, 'exists.ndjson');
  fs.writeFileSync(target, 'x');
  const decision = shouldWrite(target);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'exists');
});

test('shouldWrite: allows an existing file with force', () => {
  const dir = tempDir();
  const target = path.join(dir, 'exists.ndjson');
  fs.writeFileSync(target, 'x');
  assert.equal(shouldWrite(target, { force: true }).allowed, true);
});

test('shouldWrite: dry run never blocks, because nothing is written', () => {
  const dir = tempDir();
  const target = path.join(dir, 'exists.ndjson');
  fs.writeFileSync(target, 'x');
  assert.equal(shouldWrite(target, { dryRun: true }).allowed, true);
});

test('findOverwrites: reports only the files that exist', () => {
  const dir = tempDir();
  const a = path.join(dir, 'a.ndjson');
  const b = path.join(dir, 'b.ndjson');
  fs.writeFileSync(a, 'x');
  const found = findOverwrites([a, b]);
  assert.deepEqual(found, [a]);
});

test('loadConfig: missing file is not an error', async () => {
  const dir = tempDir();
  const result = await loadConfig(dir);
  assert.equal(result.found, false);
  assert.equal(result.error, null);
  assert.deepEqual(result.config, {});
});

test('loadConfig: reads a valid config', async () => {
  const dir = tempDir();
  fs.writeFileSync(configPathFor(dir), JSON.stringify({ out: 'build', strict: true }));
  const result = await loadConfig(dir);
  assert.equal(result.found, true);
  assert.equal(result.error, null);
  assert.equal(result.config.out, 'build');
  assert.equal(result.config.strict, true);
});

test('loadConfig: malformed JSON is reported, not swallowed', async () => {
  const dir = tempDir();
  fs.writeFileSync(configPathFor(dir), '{ not json');
  const result = await loadConfig(dir);
  assert.equal(result.found, true);
  assert.match(result.error, /not valid JSON/);
});

test('loadConfig: a JSON array is rejected as a config', async () => {
  const dir = tempDir();
  fs.writeFileSync(configPathFor(dir), '[1,2,3]');
  const result = await loadConfig(dir);
  assert.match(result.error, /must be a JSON object/);
});

test('loadConfig: strips a UTF-8 BOM', async () => {
  const dir = tempDir();
  fs.writeFileSync(configPathFor(dir), `\uFEFF${JSON.stringify({ out: 'x' })}`);
  const result = await loadConfig(dir);
  assert.equal(result.error, null);
  assert.equal(result.config.out, 'x');
});

test('writeConfig: creates the template', async () => {
  const dir = tempDir();
  const result = await writeConfig(dir);
  assert.equal(result.ok, true);
  const written = JSON.parse(fs.readFileSync(configPathFor(dir), 'utf8'));
  assert.equal(written.out, CONFIG_TEMPLATE.out);
});

test('writeConfig: refuses to clobber without force', async () => {
  const dir = tempDir();
  await writeConfig(dir);
  const second = await writeConfig(dir);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'already exists');
});

test('writeConfig: --force replaces an existing config', async () => {
  const dir = tempDir();
  fs.writeFileSync(configPathFor(dir), '{"out":"old"}');
  const result = await writeConfig(dir, { force: true });
  assert.equal(result.ok, true);
  const written = JSON.parse(fs.readFileSync(configPathFor(dir), 'utf8'));
  assert.equal(written.out, CONFIG_TEMPLATE.out);
});

test('config file name is stable', () => {
  assert.equal(CONFIG_NAME, 'rulepress.config.json');
});

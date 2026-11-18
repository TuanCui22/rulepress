#!/usr/bin/env node
import process from 'node:process';
import { checkNodeVersion } from '../src/nodecheck.js';

// Gate before anything else loads. Importing the CLI pulls in ESM features
// that fail with an unhelpful syntax error on old Node, so this check has to
// happen first, with only a tiny module imported.
const gate = checkNodeVersion(process.version);
if (!gate.ok) {
  process.stderr.write(`rulepress: ${gate.message}\n`);
  process.exitCode = 1;
} else {
  const { main } = await import('../src/cli.js');
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`rulepress: unexpected failure: ${error?.stack ?? error}\n`);
    process.exitCode = 1;
  }
}

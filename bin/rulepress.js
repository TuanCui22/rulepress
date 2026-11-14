#!/usr/bin/env node
import process from 'node:process';
import { main } from '../src/cli.js';

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`rulepress: unexpected failure: ${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });

/**
 * Cross-platform helpers: opening a folder in the OS file manager, and
 * detecting whether we are running in an interactive terminal.
 *
 * Kept separate from cli.js so both can be unit-tested without spawning.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

/**
 * Command that opens a directory in the OS file manager.
 * Returns { command, args } or null when the platform is unknown.
 */
export function openCommandFor(dir, platform = process.platform) {
  if (platform === 'win32') {
    // `explorer` returns exit code 1 even on success, so callers must not
    // treat a non-zero exit as failure.
    return { command: 'explorer', args: [dir], ignoreExitCode: true };
  }
  if (platform === 'darwin') {
    return { command: 'open', args: [dir], ignoreExitCode: false };
  }
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
    return { command: 'xdg-open', args: [dir], ignoreExitCode: false };
  }
  return null;
}

/**
 * Open a directory in the file manager. Resolves to
 * { ok: true } or { ok: false, reason }.
 * Never throws: failing to open a folder must not fail the conversion.
 */
export function openDirectory(dir, { platform = process.platform, spawnFn = spawn } = {}) {
  const spec = openCommandFor(dir, platform);
  if (!spec) {
    return Promise.resolve({ ok: false, reason: `opening folders is not supported on ${platform}` });
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      const child = spawnFn(spec.command, spec.args, { detached: true, stdio: 'ignore' });
      child.on('error', (error) => done({ ok: false, reason: error.message }));
      child.on('spawn', () => {
        if (spec.ignoreExitCode) {
          child.unref?.();
          done({ ok: true });
        }
      });
      child.on('exit', (code) => {
        if (spec.ignoreExitCode) {
          done({ ok: true });
        } else if (code === 0) {
          done({ ok: true });
        } else {
          done({ ok: false, reason: `${spec.command} exited with code ${code}` });
        }
      });
      child.unref?.();
    } catch (error) {
      done({ ok: false, reason: error.message });
    }
  });
}

/** True when both stdin and stdout are a TTY (so prompts make sense). */
export function isInteractive(streams = {}) {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;
  return Boolean(input?.isTTY && output?.isTTY);
}

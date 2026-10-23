import { execFile, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

// POSIX + Python's stdlib pty.fork supply an owned kernel PTY. The script runs
// real runChat -> React hooks -> SDK -> loopback HTTP/SSE in a child process.
// It emulates only TSP hello/ACK, so real Tern visual acceptance remains separate.
const hasPty =
  process.platform !== 'win32' &&
  spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0

describe('real OS PTY Omnara chat input', () => {
  const test = hasPty ? it : it.skip

  test('preserves fragmented UTF-8, batched keys, bracketed paste and /ask at the SDK boundary', async () => {
    const script = fileURLToPath(new URL('./pty-regression.py', import.meta.url))
    const node = process.execPath
    const tsx = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url))
    const lab = fileURLToPath(new URL('./lab.ts', import.meta.url))
    const { stdout } = await promisify(execFile)('python3', [script, node, tsx, lab], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      timeout: 70_000,
      maxBuffer: 1_048_576,
      env: {
        PATH: process.env.PATH,
        TERM: 'xterm-256color',
        NO_COLOR: '1',
      },
    })
    expect(stdout).toContain('Real OS PTY native input proof passed')
  }, 75_000)
})

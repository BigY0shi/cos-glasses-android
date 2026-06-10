// Cross-platform helpers — binary discovery, process kill, port checks, temp paths.
// The server targets macOS, Linux, and Windows; everything OS-coupled funnels
// through here so the rest of the codebase stays platform-agnostic.

import { existsSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { execSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import net from 'node:net'

export const IS_WINDOWS = process.platform === 'win32'

// Package-manager install locations searched AFTER the PATH — covers binaries
// installed by Homebrew/Linuxbrew/scoop/chocolatey/winget that aren't on the
// PATH of whatever process launched us (GUI launchers, services).
const EXTRA_BIN_DIRS: string[] = IS_WINDOWS
  ? [
      join(homedir(), 'scoop', 'shims'),
      'C:\\ProgramData\\chocolatey\\bin',
      join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Links'),
    ]
  : [
      '/opt/homebrew/bin',                 // macOS Apple Silicon
      '/usr/local/bin',                    // macOS Intel / manual installs
      '/home/linuxbrew/.linuxbrew/bin',    // Linuxbrew
      join(homedir(), '.local', 'bin'),
    ]

/**
 * Find an executable by name across the PATH plus common package-manager
 * locations. On Windows, tries PATHEXT extensions (.exe, .cmd, ...).
 * Returns the absolute path, or null when not installed.
 */
export function findBinary(name: string): string | null {
  const exts = IS_WINDOWS
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  const dirs = [
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean),
    ...EXTRA_BIN_DIRS,
  ]
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext.toLowerCase())
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
      } catch { /* unreadable dir — skip */ }
    }
    // POSIX: extensionless lookup already covered by exts = ['']
    if (IS_WINDOWS) {
      const bare = join(dir, name)
      try {
        if (existsSync(bare) && statSync(bare).isFile()) return bare
      } catch { /* skip */ }
    }
  }
  return null
}

/** Path under the OS temp directory (replaces hardcoded /tmp). */
export function tmpPath(name: string): string {
  return join(tmpdir(), name)
}

/**
 * Kill every process matching a binary name (pkill replacement).
 * Returns true if at least one process was killed.
 */
export function killProcessByName(name: string): boolean {
  try {
    if (IS_WINDOWS) {
      execSync(`taskkill /F /T /IM "${name}.exe"`, { stdio: 'ignore' })
    } else {
      execSync(`pkill -9 -f "${name}"`, { stdio: 'ignore' })
    }
    return true
  } catch {
    return false // no matching process (or kill not permitted)
  }
}

/** True when nothing is listening on the port (lsof replacement, pure Node). */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, host)
  })
}

/** Poll until the port frees up (or attempts run out). */
export async function waitForPortFree(port: number, attempts = 10, delayMs = 500): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (await isPortFree(port)) return
    await new Promise((r) => setTimeout(r, delayMs))
  }
}

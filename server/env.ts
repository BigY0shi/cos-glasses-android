// .env loader — MUST be imported first in index.ts so process.env is populated
// before python-bridge.ts reads COS_SCRIPTS_DIR.
//
// Loads the persistent launcher config (~/.cos-glasses/.env) first, then a
// repo-local .env for from-source/dev runs. Existing process.env values always
// win (the launcher pre-injects them), so this is a safe last-resort loader.

import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'

function loadEnvFile(path: string): void {
  try {
    const content = readFileSync(path, 'utf-8')
    for (const line of content.split('\n')) {
      // Allow digits in keys (e.g. COS_G2_DEFAULT_MODEL) and empty values.
      const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/)
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].trim()
      }
    }
  } catch { /* .env is optional — env vars can be set externally */ }
}

loadEnvFile(join(homedir(), '.cos-glasses', '.env'))
loadEnvFile(resolve(import.meta.dirname, '../.env'))

#!/usr/bin/env node

// COS Glasses Server Launcher
// Downloads and runs the COS Glasses server for Even G2 smart glasses

const { execSync, spawn } = require('child_process')
const { existsSync, mkdirSync, statSync, readFileSync, copyFileSync, unlinkSync, renameSync } = require('fs')
const { join, resolve } = require('path')
const { homedir } = require('os')

const COS_DIR = join(homedir(), '.cos-glasses')
const APP_DIR = join(COS_DIR, 'app')
const REPO_URL = 'https://github.com/ukaoma/cos-glasses-app.git'

// ANSI colors
const green = (s) => `\x1b[32m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`
const yellow = (s) => `\x1b[33m${s}\x1b[0m`
const dim = (s) => `\x1b[2m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`

console.log('')
console.log(bold('  COS Glasses Server'))
console.log(dim('  AI heads-up display for Even G2 smart glasses'))
console.log('')

// Step 1: Check Node version
const nodeVersion = parseInt(process.versions.node.split('.')[0])
if (nodeVersion < 18) {
  console.log(red('  \u2717 Node.js 18+ required') + ` (you have ${process.versions.node})`)
  console.log('    Update: https://nodejs.org')
  process.exit(1)
}
console.log(green('  \u2713') + ` Node.js ${process.versions.node}`)

// Step 2: Check Claude CLI
let claudeVersion = null
try {
  claudeVersion = execSync('claude --version', { stdio: 'pipe', timeout: 5000 }).toString().trim()
  console.log(green('  \u2713') + ` Claude Code ${claudeVersion}`)
} catch {
  console.log(red('  \u2717 Claude Code CLI not found'))
  console.log('')
  console.log('    Install from: ' + bold('https://claude.ai/download'))
  console.log('    Then run this command again.')
  console.log('')
  process.exit(1)
}

// Step 3: Download or update the app
if (!existsSync(APP_DIR)) {
  console.log('')
  console.log(`  ${yellow('\u2193')} Downloading COS Glasses Server...`)
  mkdirSync(COS_DIR, { recursive: true })
  try {
    execSync(`git clone --depth 1 ${REPO_URL} "${APP_DIR}"`, {
      stdio: 'pipe',
      timeout: 120000
    })
    console.log(green('  \u2713') + ' Downloaded')
  } catch (err) {
    console.log(red('  \u2717 Download failed'))
    console.log(`    ${err.message}`)
    console.log('')
    console.log('    Manual install:')
    console.log(`    git clone ${REPO_URL} "${APP_DIR}"`)
    process.exit(1)
  }
} else {
  // Check for updates (non-blocking, best-effort)
  try {
    const result = execSync('git fetch --dry-run 2>&1', {
      cwd: APP_DIR,
      stdio: 'pipe',
      timeout: 10000
    }).toString()
    if (result.trim()) {
      console.log(yellow('  \u2191') + ' Update available \u2014 run ' + dim('cd ~/.cos-glasses/app && git pull'))
    } else {
      console.log(green('  \u2713') + ' App up to date')
    }
  } catch {
    console.log(green('  \u2713') + ' App installed')
  }
}

// Step 4: npm install if needed
const nodeModules = join(APP_DIR, 'node_modules')
const packageJson = join(APP_DIR, 'package.json')

let needsInstall = !existsSync(nodeModules)
if (!needsInstall) {
  // Check if package.json is newer than node_modules
  try {
    const pkgMtime = statSync(packageJson).mtimeMs
    const nmMtime = statSync(nodeModules).mtimeMs
    needsInstall = pkgMtime > nmMtime
  } catch {
    needsInstall = true
  }
}

if (needsInstall) {
  console.log('')
  console.log(`  ${yellow('\u27f3')} Installing dependencies...`)
  try {
    execSync('npm install', {
      cwd: APP_DIR,
      stdio: 'pipe',
      timeout: 300000
    })
    console.log(green('  \u2713') + ' Dependencies installed')
  } catch (err) {
    console.log(red('  \u2717 npm install failed'))
    console.log(`    ${err.stderr?.toString().slice(0, 200) || err.message}`)
    process.exit(1)
  }
}

// Step 5: Copy .env.example if no .env exists
const envFile = join(APP_DIR, '.env')
const envExample = join(APP_DIR, '.env.example')
if (!existsSync(envFile) && existsSync(envExample)) {
  copyFileSync(envExample, envFile)
  console.log(green('  \u2713') + ' Created .env from template')
}

// Step 5b: Local Whisper detection — voice transcription is FREE if installed,
// otherwise the server silently falls back to OpenAI API ($0.006/min). Public
// users won't know they're being billed unless we tell them at startup.
//
// Detection mirrors what server/lib/whisper-local.ts looks for at runtime:
//   - whisper-cli binary (brew install whisper-cpp on macOS, native on Linux)
//   - ggml-large-v3-turbo.bin model (~1.5 GB, downloaded from Hugging Face)
//
// Probe order: known Homebrew paths (Apple Silicon + Intel), then PATH lookup
// via `command -v` for Linux/custom installs. (v5.3.2 fix — was Apple Silicon
// only, broke detection for Intel Macs and any non-Homebrew install.)
const WHISPER_KNOWN_PATHS = [
  '/opt/homebrew/bin/whisper-cli',  // Apple Silicon Homebrew
  '/usr/local/bin/whisper-cli',     // Intel Homebrew
]
const WHISPER_MODEL_DIR = join(homedir(), '.local/share/whisper-models')
const WHISPER_MODEL_PATH = join(WHISPER_MODEL_DIR, 'ggml-large-v3-turbo.bin')
const WHISPER_MODEL_PARTIAL = WHISPER_MODEL_PATH + '.partial'
const WHISPER_MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin'
// large-v3-turbo is ~1.5 GB on disk; reject anything smaller than 800 MB as a
// partial download (curl interrupted by Ctrl-C, network drop, disk full).
const WHISPER_MODEL_MIN_BYTES = 800_000_000

function findWhisperCli() {
  // Check known Homebrew install paths first (zero subprocess cost)
  for (const p of WHISPER_KNOWN_PATHS) {
    if (existsSync(p)) return p
  }
  // Fall back to shell PATH lookup for Linux / custom installs
  try {
    const found = execSync('command -v whisper-cli 2>/dev/null', {
      shell: '/bin/sh',
      stdio: 'pipe',
      timeout: 2000
    }).toString().trim()
    return found || null
  } catch {
    return null
  }
}

function isValidWhisperModel(path) {
  if (!existsSync(path)) return false
  try {
    return statSync(path).size >= WHISPER_MODEL_MIN_BYTES
  } catch {
    return false
  }
}

const whisperCliPath = findWhisperCli()
const hasValidModel = isValidWhisperModel(WHISPER_MODEL_PATH)

if (whisperCliPath && hasValidModel) {
  console.log(green('  \u2713') + ' whisper.cpp + model ready ' + dim('— voice = local (FREE)'))
} else if (whisperCliPath && !hasValidModel) {
  // CLI installed but model missing or partial — clean up any junk and download
  if (existsSync(WHISPER_MODEL_PATH)) {
    console.log(yellow('  \u26a0') + ' Existing whisper model is incomplete — re-downloading')
    try { unlinkSync(WHISPER_MODEL_PATH) } catch {}
  }
  if (existsSync(WHISPER_MODEL_PARTIAL)) {
    try { unlinkSync(WHISPER_MODEL_PARTIAL) } catch {}
  }
  console.log(yellow('  \u26a0') + ' whisper.cpp installed but model missing')
  console.log('    ' + dim('Downloading ggml-large-v3-turbo (~1.5 GB) from Hugging Face...'))
  console.log('    ' + dim('Cancel with Ctrl-C — server will use OpenAI API instead.'))
  console.log('    ' + dim('Skip permanently: SKIP_WHISPER_DOWNLOAD=1 npx @gotcos/glasses-server'))
  if (process.env.SKIP_WHISPER_DOWNLOAD === '1') {
    console.log(yellow('  \u26a0') + ' SKIP_WHISPER_DOWNLOAD=1 — voice will use OpenAI API')
  } else {
    try {
      mkdirSync(WHISPER_MODEL_DIR, { recursive: true })
      // Download to .partial first; rename only on size verification.
      // Prevents the next run from finding a corrupt file at the final path.
      execSync(`curl -fL --progress-bar "${WHISPER_MODEL_URL}" -o "${WHISPER_MODEL_PARTIAL}"`, {
        stdio: 'inherit',
        timeout: 900000  // 15 min for slow networks
      })
      const stats = statSync(WHISPER_MODEL_PARTIAL)
      if (stats.size < WHISPER_MODEL_MIN_BYTES) {
        throw new Error(`Downloaded file too small: ${stats.size} bytes (expected >= ${WHISPER_MODEL_MIN_BYTES})`)
      }
      // Atomic rename — final path is either valid or doesn't exist
      renameSync(WHISPER_MODEL_PARTIAL, WHISPER_MODEL_PATH)
      console.log(green('  \u2713') + ' Model downloaded ' + dim('— voice = local (FREE)'))
    } catch (err) {
      // Clean up partial — never leave junk at the final path
      try { unlinkSync(WHISPER_MODEL_PARTIAL) } catch {}
      console.log(red('  \u2717') + ' Model download failed ' + dim('— voice will use OpenAI API'))
      console.log('    ' + dim('Error: ' + (err.message || err).toString().slice(0, 120)))
      console.log('    ' + dim('Manual: curl -fL ' + WHISPER_MODEL_URL + ' -o ' + WHISPER_MODEL_PATH))
    }
  }
} else {
  // No whisper-cli — voice will fall back to OpenAI API
  console.log(yellow('  \u26a0') + ' whisper.cpp not installed ' + dim('— voice will use OpenAI API ($0.006/min)'))
  console.log('    For free local voice transcription:')
  console.log('    macOS: ' + bold('brew install whisper-cpp') + dim('  (no Homebrew? https://brew.sh)'))
  console.log('    Linux: ' + bold('Build from https://github.com/ggerganov/whisper.cpp'))
  console.log('    ' + dim('Then re-run npx @gotcos/glasses-server to download the model.'))
}

// Step 6: Start the server
console.log('')
console.log(dim('  Starting server...'))
console.log('')

// Pass through any env vars from command line
// Support: OPENAI_API_KEY=sk-... npx @gotcos/glasses-server
const serverProc = spawn(
  process.execPath, // node
  ['--import', 'tsx/esm', 'server/index.ts'],
  {
    cwd: APP_DIR,
    stdio: 'inherit',
    env: {
      ...process.env,
      // Don't override COS_SCRIPTS_DIR if not set — let standalone mode activate
    }
  }
)

serverProc.on('error', (err) => {
  console.error(red(`  Server failed to start: ${err.message}`))
  if (err.message.includes('tsx')) {
    console.error('  Try: cd ~/.cos-glasses/app && npm install tsx')
  }
  process.exit(1)
})

serverProc.on('exit', (code) => {
  process.exit(code ?? 0)
})

// Forward signals
process.on('SIGINT', () => serverProc.kill('SIGINT'))
process.on('SIGTERM', () => serverProc.kill('SIGTERM'))

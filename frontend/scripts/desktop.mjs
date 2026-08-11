/**
 * Cross-platform Tauri launcher. On Windows, prepends ~/.cargo/bin when needed
 * (conda shells often omit it).
 *
 * Usage:
 *   node scripts/desktop.mjs dev
 *   node scripts/desktop.mjs build
 *   node scripts/desktop.mjs build --target universal-apple-darwin
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2).filter((a) => a !== '--')
const mode = argv[0] === 'build' ? 'build' : 'dev'
const tauriArgs = [mode, ...argv.slice(1)]

if (process.platform === 'win32') {
  const cargoBin = join(homedir(), '.cargo', 'bin')
  const cargoExe = join(cargoBin, 'cargo.exe')
  if (existsSync(cargoExe)) {
    process.env.Path = `${cargoBin};${process.env.Path ?? process.env.PATH ?? ''}`
  } else {
    console.error(
      `cargo not found at ${cargoBin}. Install with: winget install Rustlang.Rustup then open a new terminal.`,
    )
    process.exit(1)
  }
}

console.log(`tauri ${tauriArgs.join(' ')} (cwd: ${root})`)
const child = spawn('npx', ['tauri', ...tauriArgs], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env: process.env,
})
child.on('exit', (code, signal) => {
  if (signal) process.exit(1)
  process.exit(code ?? 1)
})

/** Fail-loud verification of the runtime entries sealed into Electron's app.asar. */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { listPackage } from '@electron/asar'
import AdmZip from 'adm-zip'
import {
  FORBIDDEN_MACOS_UNIVERSAL_ENTRIES,
  MACOS_UNIVERSAL_NATIVE_ENTRIES,
} from './mac-universal.ts'

const DSH_PACKAGE_ROOT = dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'))
const PNPM_PACKAGE_ROOT = dirname(createRequire(import.meta.url).resolve('pnpm/package.json'))

function packageVersion(packageRoot: string): string {
  return (JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string }).version
}

const DSH_RUNTIME_VERSION = packageVersion(DSH_PACKAGE_ROOT)
const PNPM_RUNTIME_VERSION = packageVersion(PNPM_PACKAGE_ROOT)

/** Maximum physical file count accepted beside ASAR after smart unpack. */
export const MAX_UNPACKED_RUNTIME_FILES = 1_500

/** Every generated JavaScript file shipped by the installed DSH CLI package. */
export const REQUIRED_DSH_CLI_RUNTIME_ENTRIES = Object.freeze(
  readdirSync(join(DSH_PACKAGE_ROOT, 'lib'), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => `node_modules/@deepseek-ai/dsh/lib/${entry.name}`)
    .sort(),
)

/** AfterPack fields consumed without importing Electron Builder's incomplete declaration graph. */
export interface PackagedRuntimeContext {
  /** Completed platform application directory. */
  readonly appOutDir: string
  /** Electron Builder target architecture (`4` is its stable universal enum value). */
  readonly arch?: number
  /** Electron target platform selected by the packager. */
  readonly electronPlatformName: string
  /** Product metadata used to locate the macOS application bundle. */
  readonly packager: {
    readonly appInfo: {
      readonly productFilename: string
    }
  }
}

/** Exact archive entries required by the desktop launcher on every supported platform. */
export const REQUIRED_PACKAGED_RUNTIME_ENTRIES = [
  'package.json',
  'lib/main.js',
  'lib/client.js',
  'lib/native-ui/profile-create.html',
  'lib/native-ui/recovery.html',
  'lib/native-ui/setup-wizard.html',
  'lib/profile.js',
  'lib/profile-manager.js',
  'lib/profile-service.js',
  'lib/pnpm.js',
  'lib/profiles.js',
  'lib/diagnostics.js',
  'lib/diagnostic-export-worker.js',
  'lib/packaged-runtime-smoke.js',
  'lib/desktop-cli.js',
  'lib/desktop-runtime-environment.js',
  'lib/desktop-terminal.js',
  'lib/terminal.js',
  'lib/update-checker.js',
  'lib/update-download.js',
  'lib/updates.js',
  'lib/windows-acl-runner.js',
  ...REQUIRED_DSH_CLI_RUNTIME_ENTRIES,
  'node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js',
  'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
  'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
  'node_modules/open/index.js',
  'node_modules/pnpm/bin/pnpm.mjs',
] as const

/** Small desktop-owned surface intentionally kept physical beside app.asar. */
export const REQUIRED_UNPACKED_RUNTIME_ENTRIES = [
  'build/app-icon.png',
  'build/app-icon-mac.png',
  'build/tray-iconTemplate.png',
  'build/tray-icon-blue.png',
  'lib/main.js',
  'lib/client.js',
  'lib/native-ui/profile-create.html',
  'lib/native-ui/recovery.html',
  'lib/native-ui/setup-wizard.html',
  'lib/index.js',
  'lib/profile.js',
  'lib/profile-manager.js',
  'lib/profile-service.js',
  'lib/pnpm.js',
  'lib/profiles.js',
  'lib/diagnostics.js',
  'lib/diagnostic-export-worker.js',
  'lib/packaged-runtime-smoke.js',
  'lib/terminal.js',
  'lib/update-download.js',
  'lib/updates.js',
  'lib/windows-pwsh-sandbox.js',
] as const

/** Ordinary modules that must stay archived to prevent a full physical mirror regression. */
export const FORBIDDEN_UNPACKED_RUNTIME_ENTRIES = [
  'package.json',
  'cordis.patch.yml',
  'node_modules/@deepseek-ai/dsh/lib/bin.js',
  'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
  'node_modules/@deepseek-ai/dsh-base/lib/index.js',
  'node_modules/@deepseek-ai/dsh-web-app/lib/index.js',
  'node_modules/@vscode/ripgrep/lib/index.js',
  'node_modules/open/index.js',
  'node_modules/pnpm/bin/pnpm.mjs',
  'node_modules/yaml/dist/index.js',
] as const

/** Prebuilt Node-API modules required when the Windows package skips native source rebuilds. */
export const REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES = [
  'node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe',
  'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
  'node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.node',
  'node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe',
  'node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll',
] as const

/** CPU-specific runtime assets that must coexist in a universal macOS application. */
export const REQUIRED_MACOS_UNIVERSAL_ENTRIES = [
  ...MACOS_UNIVERSAL_NATIVE_ENTRIES.map(entry => entry.path),
] as const

/** Injectable archive listing seam used by focused tests. */
export type ArchiveLister = (archivePath: string, options: { isPack: boolean }) => readonly string[]

/** Injectable physical-file probe used by focused tests. */
export type FileProbe = (filename: string) => boolean

/** Injectable physical unpacked-file inventory used by focused tests. */
export type UnpackedFileLister = (unpackedRoot: string) => readonly string[]

/** Inputs understood by the bundled diagnostics Worker. */
export interface PackagedDiagnosticWorkerData {
  readonly logsDir: string
  readonly userDataDir: string
  readonly appVersion: string
  readonly maxEvidenceBytes: number
  readonly crashDumpsDir: string
}

/** Injectable packaged Worker launcher used by focused tests. */
export type PackagedDiagnosticWorkerLauncher = (
  workerPath: string,
  workerData: PackagedDiagnosticWorkerData,
) => Promise<string>

/** Injectable smoke seam used to verify afterPack ordering. */
export type PackagedDiagnosticWorkerSmoke = (unpackedRoot: string) => Promise<void>

/** Result surface required from one packaged Electron child. */
export interface PackagedElectronResult {
  readonly error?: Error
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Injectable packaged Electron process seam used by focused tests. */
export type PackagedElectronRunner = (
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
) => PackagedElectronResult

/** Injectable ASAR/CLI/native smoke seam used to verify afterPack ordering. */
export type PackagedElectronSmoke = (context: PackagedRuntimeContext) => void

/** Result posted by the bundled diagnostics Worker. */
type PackagedDiagnosticWorkerResult =
  | { readonly ok: true, readonly path: string }
  | { readonly ok: false, readonly error: string }

const PACKAGED_DIAGNOSTIC_WORKER_TIMEOUT_MS = 30_000

/** Start the physical packaged diagnostics Worker and wait for its terminal result. */
async function launchPackagedDiagnosticWorker(
  workerPath: string,
  workerData: PackagedDiagnosticWorkerData,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, {
      name: 'dsh-packaged-diagnostic-smoke',
      workerData,
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    })
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      void worker.terminate()
      reject(new Error(
        `dsh-plugin-desktop: packaged diagnostic worker timed out after ${String(PACKAGED_DIAGNOSTIC_WORKER_TIMEOUT_MS)}ms`,
      ))
    }, PACKAGED_DIAGNOSTIC_WORKER_TIMEOUT_MS)
    const settle = (complete: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      void worker.terminate()
      complete()
    }
    worker.once('message', (result: PackagedDiagnosticWorkerResult) => {
      if (result.ok) settle(() => resolve(result.path))
      else settle(() => reject(new Error(result.error)))
    })
    worker.once('error', cause => settle(() => reject(cause)))
    worker.once('exit', (code) => {
      settle(() => reject(new Error(
        `dsh-plugin-desktop: packaged diagnostic worker exited with code ${String(code)}`,
      )))
    })
  })
}

/** Exercise the physical Worker emitted beside app.asar with a minimal archive. */
export async function smokePackagedDiagnosticWorker(
  unpackedRoot: string,
  launch: PackagedDiagnosticWorkerLauncher = launchPackagedDiagnosticWorker,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-packaged-diagnostics-'))
  const logsDir = join(root, 'logs')
  const userDataDir = join(root, 'user-data')
  const crashDumpsDir = join(root, 'Crashpad')
  mkdirSync(logsDir)
  mkdirSync(userDataDir)
  mkdirSync(join(crashDumpsDir, 'pending'), { recursive: true })
  writeFileSync(join(logsDir, 'dsh-2000-01-01.log'), 'packaged worker smoke\n')
  writeFileSync(join(crashDumpsDir, 'pending', 'packaged-smoke.dmp'), 'packaged crash dump smoke\n')
  try {
    const output = await launch(
      join(unpackedRoot, 'lib', 'diagnostic-export-worker.js'),
      { logsDir, userDataDir, appVersion: 'packaged-smoke', maxEvidenceBytes: 1024, crashDumpsDir },
    )
    if (!existsSync(output)) {
      throw new Error(`dsh-plugin-desktop: packaged diagnostic worker produced no archive at ${output}`)
    }
    const crashEntry = 'crash-dumps/pending/packaged-smoke.dmp'
    if (new AdmZip(output).getEntry(crashEntry) === null) {
      throw new Error(`dsh-plugin-desktop: packaged diagnostic worker omitted ${crashEntry}`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** Resolve the packaged Electron executable created beside the application resources. */
export function resolvePackagedExecutablePath(context: PackagedRuntimeContext): string {
  const filename = context.packager.appInfo.productFilename
  if (context.electronPlatformName === 'darwin') {
    return join(context.appOutDir, `${filename}.app`, 'Contents', 'MacOS', filename)
  }
  if (context.electronPlatformName === 'win32') return join(context.appOutDir, `${filename}.exe`)
  if (context.electronPlatformName === 'linux') return join(context.appOutDir, filename)
  throw new Error(
    `dsh-plugin-desktop: unsupported Electron afterPack platform ${JSON.stringify(context.electronPlatformName)}`,
  )
}

function runPackagedElectron(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): PackagedElectronResult {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    env: environment,
    shell: false,
    timeout: 60_000,
    windowsHide: true,
  })
  return {
    ...(result.error === undefined ? {} : { error: result.error }),
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function packagedRuntimeRunnable(context: PackagedRuntimeContext): boolean {
  if (context.electronPlatformName !== process.platform) return false
  const { arch } = context
  if (arch === undefined || arch === 4) return true
  if (arch === 1) return process.arch === 'x64'
  if (arch === 3) return process.arch === 'arm64'
  if (arch === 0) return process.arch === 'ia32'
  return false
}

/**
 * Execute the real packaged runtime through Electron's supported RunAsNode
 * path. This proves DSH and pnpm can load from logical ASAR paths, the upstream
 * Profile proxy selects Electron, and smartUnpack exposes the ripgrep binary.
 */
export function smokePackagedElectronRuntime(
  context: PackagedRuntimeContext,
  run: PackagedElectronRunner = runPackagedElectron,
): void {
  // A universal executable runs natively on either macOS CPU. Per-architecture
  // intermediate apps are only executable on the matching packaging host.
  if (!packagedRuntimeRunnable(context)) return
  const executable = resolvePackagedExecutablePath(context)
  const asarRoot = resolvePackagedAsarPath(context)
  const smokeHome = mkdtempSync(join(tmpdir(), 'dsh-packaged-cli-'))
  const environment = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: smokeHome,
    DSH_TELEMETRY_DISABLED: '1',
  }
  const checks = [
    {
      label: 'DSH CLI',
      entry: join(asarRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      args: ['--version'],
      accepts: (stdout: string) => stdout.trim() === DSH_RUNTIME_VERSION,
    },
    {
      label: 'pnpm CLI',
      entry: join(asarRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
      args: ['--version'],
      accepts: (stdout: string) => stdout.trim() === PNPM_RUNTIME_VERSION,
    },
    {
      label: 'ASAR/Profile/CJS/ripgrep',
      entry: join(asarRoot, 'lib', 'packaged-runtime-smoke.js'),
      args: [],
      accepts: (stdout: string) => stdout.trim() === 'DSH_PACKAGED_RUNTIME_OK',
    },
    {
      // This is deliberately the Desktop wrapper rather than DSH's bin.js:
      // a child RunAsNode process cannot inherit main's resolver hook.
      label: 'Desktop CLI Profile boot',
      entry: join(asarRoot, 'lib', 'desktop-cli.js'),
      args: ['--profile', 'headless', '--help'],
      accepts: (stdout: string) => stdout.includes('dsh --profile headless'),
    },
  ] as const
  try {
    for (const check of checks) {
      const result = run(executable, ['--expose-internals', check.entry, ...check.args], environment)
      if (result.error !== undefined) {
        throw new Error(`dsh-plugin-desktop: packaged ${check.label} smoke could not start`, {
          cause: result.error,
        })
      }
      if (result.status !== 0 || !check.accepts(result.stdout)) {
        throw new Error(
          `dsh-plugin-desktop: packaged ${check.label} smoke failed with status ${String(result.status)}; `
          + `stdout=${JSON.stringify(result.stdout.trim())}; stderr=${JSON.stringify(result.stderr.trim())}`,
        )
      }
    }
    const obsoleteFallback = join(smokeHome, 'profiles', 'node_modules')
    if (existsSync(obsoleteFallback) && readdirSync(obsoleteFallback).length > 0) {
      throw new Error(
        `dsh-plugin-desktop: packaged Desktop CLI recreated the obsolete shared Profile fallback at ${obsoleteFallback}`,
      )
    }
  } finally {
    rmSync(smokeHome, { recursive: true, force: true })
  }
}

/**
 * Resolve the platform-specific archive produced by Electron Builder.
 * @param context - completed application directory and target platform.
 * @returns absolute path to the packaged app.asar.
 */
export function resolvePackagedAsarPath(context: PackagedRuntimeContext): string {
  if (context.electronPlatformName === 'darwin') {
    return join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      'Contents',
      'Resources',
      'app.asar',
    )
  }
  if (context.electronPlatformName === 'win32' || context.electronPlatformName === 'linux') {
    return join(context.appOutDir, 'resources', 'app.asar')
  }
  throw new Error(
    `dsh-plugin-desktop: unsupported Electron afterPack platform ${JSON.stringify(context.electronPlatformName)}`,
  )
}

/**
 * Resolve the physical dependency tree emitted beside app.asar.
 * @param context - completed application directory and target platform.
 * @returns absolute path to app.asar.unpacked.
 */
export function resolvePackagedUnpackedRoot(context: PackagedRuntimeContext): string {
  return `${resolvePackagedAsarPath(context)}.unpacked`
}

/** Normalize the host-specific separators emitted by the ASAR reader. */
function normalizeArchiveEntry(entry: string): string {
  return entry.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '')
}

/**
 * Inspect one archive and reject an incomplete packaged runtime.
 * @param archivePath - resolved app.asar path.
 * @param list - ASAR listing implementation.
 * @returns The normalized archive entry set for physical mirror verification.
 */
export function verifyPackagedAsar(
  archivePath: string,
  list: ArchiveLister = listPackage,
): ReadonlySet<string> {
  let entries: readonly string[]
  try {
    entries = list(archivePath, { isPack: false })
  } catch (cause) {
    throw new Error(
      `dsh-plugin-desktop: failed to inspect packaged runtime at ${archivePath}`,
      { cause },
    )
  }

  const present = new Set(entries.map(normalizeArchiveEntry))
  const missing = REQUIRED_PACKAGED_RUNTIME_ENTRIES.filter(entry => !present.has(entry))
  if (missing.length > 0) {
    throw new Error(
      `dsh-plugin-desktop: packaged runtime at ${archivePath} is missing required ASAR entries: ${missing.join(', ')}`,
    )
  }
  return present
}

/** Enumerate physical files without following links outside the unpacked tree. */
export function listUnpackedRuntimeFiles(unpackedRoot: string): string[] {
  const files: string[] = []
  const pending = ['']
  for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    for (const entry of readdirSync(join(unpackedRoot, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else files.push(path.replaceAll('\\', '/'))
    }
  }
  return files.sort()
}

/**
 * Reject a regression back to the old full app.asar mirror. Every physical
 * file must still be declared by the ASAR header, ordinary JS sentinels must
 * remain archived, and Electron Builder's smart-unpacked native surface stays
 * under a hard file-count budget.
 */
export function verifySelectiveUnpackedRuntime(
  archiveEntries: ReadonlySet<string>,
  unpackedRoot: string,
  files: readonly string[],
  exists: FileProbe = existsSync,
): void {
  const normalizedFiles = files.map(normalizeArchiveEntry)
  const outsideArchive = normalizedFiles.filter(entry => !archiveEntries.has(entry))
  if (outsideArchive.length > 0) {
    throw new Error(
      `dsh-plugin-desktop: unpacked runtime at ${unpackedRoot} contains entries outside app.asar: ${outsideArchive.join(', ')}`,
    )
  }
  const forbidden = FORBIDDEN_UNPACKED_RUNTIME_ENTRIES
    .filter(entry => exists(join(unpackedRoot, entry)))
  if (forbidden.length > 0) {
    throw new Error(
      `dsh-plugin-desktop: unpacked runtime at ${unpackedRoot} mirrors ordinary archived modules: ${forbidden.join(', ')}`,
    )
  }
  if (normalizedFiles.length > MAX_UNPACKED_RUNTIME_FILES) {
    throw new Error(
      `dsh-plugin-desktop: unpacked runtime at ${unpackedRoot} contains ${String(normalizedFiles.length)} files; `
      + `selective ASAR budget is ${String(MAX_UNPACKED_RUNTIME_FILES)}`,
    )
  }
}

/**
 * Verify Electron Builder's completed application before signing begins.
 * @param context - Electron Builder's afterPack context.
 * @param list - ASAR listing implementation.
 * @param exists - physical-file probe for the unpacked CLI dependency tree.
 * @param listUnpacked - physical file inventory below app.asar.unpacked.
 * @returns Nothing; failure rejects the package before signing.
 */
export function verifyPackagedRuntime(
  context: PackagedRuntimeContext,
  list: ArchiveLister = listPackage,
  exists: FileProbe = existsSync,
  listUnpacked: UnpackedFileLister = listUnpackedRuntimeFiles,
): void {
  const archiveEntries = verifyPackagedAsar(resolvePackagedAsarPath(context), list)
  const unpackedRoot = resolvePackagedUnpackedRoot(context)
  const requiredPhysicalEntries = context.electronPlatformName === 'win32'
    ? [...REQUIRED_UNPACKED_RUNTIME_ENTRIES, ...REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES]
    : context.electronPlatformName === 'darwin' && context.arch === 4
      ? [...REQUIRED_UNPACKED_RUNTIME_ENTRIES, ...REQUIRED_MACOS_UNIVERSAL_ENTRIES]
      : REQUIRED_UNPACKED_RUNTIME_ENTRIES
  const missing = requiredPhysicalEntries.filter(entry => !exists(join(unpackedRoot, entry)))
  if (missing.length > 0) {
    throw new Error(
      `dsh-plugin-desktop: packaged runtime at ${unpackedRoot} is missing required physical entries: ${missing.join(', ')}`,
    )
  }
  if (context.electronPlatformName === 'darwin' && context.arch === 4) {
    const forbidden = FORBIDDEN_MACOS_UNIVERSAL_ENTRIES
      .filter(entry => exists(join(unpackedRoot, entry)))
    if (forbidden.length > 0) {
      throw new Error(
        `dsh-plugin-desktop: universal macOS runtime at ${unpackedRoot} contains host-architecture build output: ${forbidden.join(', ')}`,
      )
    }
  }
  verifySelectiveUnpackedRuntime(archiveEntries, unpackedRoot, listUnpacked(unpackedRoot), exists)
}

/**
 * Run the static packaged-runtime check as Electron Builder's afterPack hook.
 * @param context - Electron Builder's afterPack context.
 * @returns A promise that rejects before signing when the runtime is incomplete.
 */
export async function afterPack(
  context: PackagedRuntimeContext,
  verify: typeof verifyPackagedRuntime = verifyPackagedRuntime,
  smoke: PackagedDiagnosticWorkerSmoke = smokePackagedDiagnosticWorker,
  electronSmoke: PackagedElectronSmoke = smokePackagedElectronRuntime,
): Promise<void> {
  verify(context)
  await smoke(resolvePackagedUnpackedRoot(context))
  electronSmoke(context)
}

export default afterPack

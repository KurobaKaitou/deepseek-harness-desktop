import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import AdmZip from 'adm-zip'
import {
  afterPack,
  FORBIDDEN_UNPACKED_RUNTIME_ENTRIES,
  MAX_UNPACKED_RUNTIME_FILES,
  REQUIRED_DSH_CLI_RUNTIME_ENTRIES,
  REQUIRED_PACKAGED_RUNTIME_ENTRIES,
  REQUIRED_MACOS_UNIVERSAL_ENTRIES,
  REQUIRED_UNPACKED_RUNTIME_ENTRIES,
  REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES,
  resolvePackagedAsarPath,
  resolvePackagedExecutablePath,
  resolvePackagedUnpackedRoot,
  smokePackagedDiagnosticWorker,
  smokePackagedElectronRuntime,
  verifyPackagedRuntime,
  verifySelectiveUnpackedRuntime,
  type ArchiveLister,
  type FileProbe,
  type PackagedElectronRunner,
  type PackagedRuntimeContext,
  type PackagedDiagnosticWorkerLauncher,
} from '../scripts/verify-packaged-runtime.ts'
import { FORBIDDEN_MACOS_UNIVERSAL_ENTRIES } from '../scripts/mac-universal.ts'

function context(
  appOutDir: string,
  electronPlatformName: string,
  arch?: number,
): PackagedRuntimeContext {
  return {
    appOutDir,
    electronPlatformName,
    ...(arch === undefined ? {} : { arch }),
    packager: { appInfo: { productFilename: 'DSH Desktop' } },
  }
}

function completeArchiveEntries(separator = '/'): string[] {
  return [...new Set([
    ...REQUIRED_PACKAGED_RUNTIME_ENTRIES,
    ...REQUIRED_UNPACKED_RUNTIME_ENTRIES,
    ...REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES,
    ...REQUIRED_MACOS_UNIVERSAL_ENTRIES,
  ])].map(entry => `${separator}${entry.replaceAll('/', separator)}`)
}

function requiredPhysicalEntries(runtimeContext: PackagedRuntimeContext): string[] {
  if (runtimeContext.electronPlatformName === 'win32') {
    return [...REQUIRED_UNPACKED_RUNTIME_ENTRIES, ...REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES]
  }
  if (runtimeContext.electronPlatformName === 'darwin' && runtimeContext.arch === 4) {
    return [...REQUIRED_UNPACKED_RUNTIME_ENTRIES, ...REQUIRED_MACOS_UNIVERSAL_ENTRIES]
  }
  return [...REQUIRED_UNPACKED_RUNTIME_ENTRIES]
}

function physicalFixture(
  runtimeContext: PackagedRuntimeContext,
  options: { missing?: string; extra?: readonly string[] } = {},
): { exists: FileProbe; files: string[] } {
  const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
  const files = [...requiredPhysicalEntries(runtimeContext), ...(options.extra ?? [])]
    .filter(entry => entry !== options.missing)
  return {
    files,
    exists: filename => files.includes(relative(unpackedRoot, filename).replaceAll('\\', '/')),
  }
}

describe('packaged desktop runtime verification', () => {
  it('tracks every generated DSH CLI chunk without pinning one release hash', () => {
    expect(REQUIRED_DSH_CLI_RUNTIME_ENTRIES).toContain('node_modules/@deepseek-ai/dsh/lib/bin.js')
    expect(REQUIRED_DSH_CLI_RUNTIME_ENTRIES).toContain('node_modules/@deepseek-ai/dsh/lib/plugin-F7ZVfRyo.js')
    expect(REQUIRED_DSH_CLI_RUNTIME_ENTRIES).not.toContain('node_modules/@deepseek-ai/dsh/lib/plugin-9h8shc4d.js')
  })

  it('fails the diagnostic Worker smoke when its archive omits the crash dump', async () => {
    const unpackedRoot = resolvePackagedUnpackedRoot(context('/build', 'win32'))
    const launch = vi.fn<PackagedDiagnosticWorkerLauncher>(async (_workerPath, workerData) => {
      const outDir = join(workerData.userDataDir, 'diagnostics')
      mkdirSync(outDir)
      const output = join(outDir, 'diagnostics-smoke.zip')
      const zip = new AdmZip()
      zip.addFile('system-info.txt', Buffer.from('no dump\n'))
      zip.writeZip(output)
      return output
    })

    await expect(smokePackagedDiagnosticWorker(unpackedRoot, launch))
      .rejects.toThrow('packaged diagnostic worker omitted crash-dumps/pending/packaged-smoke.dmp')
  })

  it.each(['darwin', 'win32'])(
    'targets the physical diagnostic Worker in the %s unpacked layout and removes smoke files',
    async (platform) => {
      const unpackedRoot = resolvePackagedUnpackedRoot(context('/build', platform))
      let smokeRoot: string | undefined
      const launch = vi.fn<PackagedDiagnosticWorkerLauncher>(async (workerPath, workerData) => {
        smokeRoot = join(workerData.logsDir, '..')
        expect(workerPath).toBe(join(unpackedRoot, 'lib', 'diagnostic-export-worker.js'))
        expect(readFileSync(join(workerData.logsDir, 'dsh-2000-01-01.log'), 'utf8'))
          .toBe('packaged worker smoke\n')
        expect(workerData.appVersion).toBe('packaged-smoke')
        expect(workerData.maxEvidenceBytes).toBe(1024)
        const crashDump = readFileSync(join(workerData.crashDumpsDir, 'pending', 'packaged-smoke.dmp'))
        expect(crashDump.toString('utf8')).toBe('packaged crash dump smoke\n')
        const outDir = join(workerData.userDataDir, 'diagnostics')
        mkdirSync(outDir)
        const output = join(outDir, 'diagnostics-smoke.zip')
        const zip = new AdmZip()
        zip.addFile('crash-dumps/pending/packaged-smoke.dmp', crashDump)
        zip.writeZip(output)
        return output
      })

      await smokePackagedDiagnosticWorker(unpackedRoot, launch)

      expect(launch).toHaveBeenCalledOnce()
      expect(smokeRoot).toBeDefined()
      expect(existsSync(smokeRoot as string)).toBe(false)
    },
  )

  it('runs static, physical Worker, and real Electron smokes in order', async () => {
    const runtimeContext = context('/build', 'win32')
    const calls: string[] = []

    await afterPack(
      runtimeContext,
      () => { calls.push('static') },
      async (unpackedRoot) => { calls.push(unpackedRoot) },
      () => { calls.push('electron') },
    )

    expect(calls).toEqual([
      'static',
      resolvePackagedUnpackedRoot(runtimeContext),
      'electron',
    ])
  })

  it('tracks ripgrep and the ConPTY native surface required on Windows', () => {
    expect(REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES).toEqual([
      'node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe',
      'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
      'node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.node',
      'node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe',
      'node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll',
    ])
  })

  it.each([
    [
      'darwin',
      join('/build', 'DSH Desktop.app', 'Contents', 'Resources', 'app.asar'),
      join('/build', 'DSH Desktop.app', 'Contents', 'MacOS', 'DSH Desktop'),
    ],
    [
      'win32',
      join('/build', 'resources', 'app.asar'),
      join('/build', 'DSH Desktop.exe'),
    ],
  ])('inspects the %s selective ASAR layout', (platform, expectedPath, expectedExecutable) => {
    const runtimeContext = context('/build', platform)
    const list = vi.fn<ArchiveLister>(() => completeArchiveEntries(platform === 'win32' ? '\\' : '/'))
    const fixture = physicalFixture(runtimeContext)
    const listUnpacked = vi.fn(() => fixture.files)

    verifyPackagedRuntime(runtimeContext, list, fixture.exists, listUnpacked)

    expect(resolvePackagedAsarPath(runtimeContext)).toBe(expectedPath)
    expect(resolvePackagedExecutablePath(runtimeContext)).toBe(expectedExecutable)
    expect(list).toHaveBeenCalledWith(expectedPath, { isPack: false })
    expect(listUnpacked).toHaveBeenCalledWith(`${expectedPath}.unpacked`)
  })

  it('rejects an unsupported platform instead of guessing a package layout', () => {
    expect(() => resolvePackagedAsarPath(context('/build', 'mas')))
      .toThrow('unsupported Electron afterPack platform "mas"')
    expect(() => resolvePackagedExecutablePath(context('/build', 'mas')))
      .toThrow('unsupported Electron afterPack platform "mas"')
  })

  it('requires both CPU variants from a universal macOS runtime', () => {
    const runtimeContext = context('/build', 'darwin', 4)
    const missing = 'node_modules/@vscode/ripgrep-darwin-x64/bin/rg'
    const incomplete = physicalFixture(runtimeContext, { missing })

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      incomplete.exists,
      () => incomplete.files,
    )).toThrow(`missing required physical entries: ${missing}`)

    const complete = physicalFixture(runtimeContext)
    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      complete.exists,
      () => complete.files,
    )).not.toThrow()
  })

  it('rejects unpacked files absent from the ASAR header', () => {
    const unpackedRoot = join('/build', 'resources', 'app.asar.unpacked')
    const unexpected = 'node_modules/unexpected/index.js'

    expect(() => verifySelectiveUnpackedRuntime(
      new Set(['lib/main.js']),
      unpackedRoot,
      ['lib/main.js', unexpected],
      () => false,
    )).toThrow(`contains entries outside app.asar: ${unexpected}`)
  })

  it.each(FORBIDDEN_UNPACKED_RUNTIME_ENTRIES)(
    'rejects mirrored ordinary module %s from the physical tree',
    (forbidden) => {
      const unpackedRoot = join('/build', 'resources', 'app.asar.unpacked')
      expect(() => verifySelectiveUnpackedRuntime(
        new Set([forbidden]),
        unpackedRoot,
        [forbidden],
        filename => filename === join(unpackedRoot, forbidden),
      )).toThrow(`mirrors ordinary archived modules: ${forbidden}`)
    },
  )

  it('caps Electron Builder smartUnpack output instead of accepting a full mirror', () => {
    const files = Array.from(
      { length: MAX_UNPACKED_RUNTIME_FILES + 1 },
      (_, index) => `node_modules/native-${String(index)}/binding.node`,
    )
    expect(() => verifySelectiveUnpackedRuntime(
      new Set(files),
      '/build/resources/app.asar.unpacked',
      files,
      () => false,
    )).toThrow(`selective ASAR budget is ${String(MAX_UNPACKED_RUNTIME_FILES)}`)
  })

  it('rejects a host-architecture node-pty build from a universal app', () => {
    const runtimeContext = context('/build', 'darwin', 4)
    const forbidden = FORBIDDEN_MACOS_UNIVERSAL_ENTRIES[0]
    const fixture = physicalFixture(runtimeContext, { extra: [forbidden] })

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      fixture.exists,
      () => fixture.files,
    )).toThrow(`contains host-architecture build output: ${forbidden}`)
  })

  it.each([
    'lib/client.js',
    'lib/native-ui/setup-wizard.html',
    'lib/desktop-runtime-environment.js',
    'lib/profile-service.js',
    'lib/diagnostics.js',
    'lib/diagnostic-export-worker.js',
    'lib/packaged-runtime-smoke.js',
    'lib/pnpm.js',
    'lib/update-download.js',
    'node_modules/open/index.js',
  ])('fails loud when required ASAR entry %s is absent', (missing) => {
    const entries = completeArchiveEntries().filter(entry => entry !== `/${missing}`)

    expect(() => verifyPackagedRuntime(context('/build', 'win32'), () => entries, () => false))
      .toThrow(`missing required ASAR entries: ${missing}`)
  })

  it.each([
    'build/app-icon-mac.png',
    'build/tray-iconTemplate.png',
    'lib/native-ui/setup-wizard.html',
    'lib/terminal.js',
    'lib/diagnostics.js',
    'lib/diagnostic-export-worker.js',
    'lib/packaged-runtime-smoke.js',
    'lib/update-download.js',
    'node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe',
    'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
  ])('fails loud when selective physical entry %s is absent', (missing) => {
    const runtimeContext = context('/build', 'win32')
    const fixture = physicalFixture(runtimeContext, { missing })

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      fixture.exists,
      () => fixture.files,
    )).toThrow(`missing required physical entries: ${missing}`)
  })

  it('runs every logical ASAR entry through the packaged Electron executable', () => {
    const runtimeContext = context('/build', process.platform)
    const dshVersion = JSON.parse(readFileSync(
      new URL('../node_modules/@deepseek-ai/dsh/package.json', import.meta.url),
      'utf8',
    )).version as string
    const pnpmVersion = JSON.parse(readFileSync(
      new URL('../node_modules/pnpm/package.json', import.meta.url),
      'utf8',
    )).version as string
    const run = vi.fn<PackagedElectronRunner>((_executable, args) => ({
      status: 0,
      stdout: args.some(arg => arg.endsWith('/@deepseek-ai/dsh/lib/bin.js'))
        ? dshVersion
        : args.some(arg => arg.endsWith('/pnpm/bin/pnpm.mjs'))
          ? pnpmVersion
          : args.some(arg => arg.endsWith('/lib/desktop-cli.js'))
            ? 'Usage: dsh --profile headless [options]'
          : 'DSH_PACKAGED_RUNTIME_OK',
      stderr: '',
    }))

    smokePackagedElectronRuntime(runtimeContext, run)

    expect(run).toHaveBeenCalledTimes(4)
    for (const [executable, args, environment] of run.mock.calls) {
      expect(executable).toBe(resolvePackagedExecutablePath(runtimeContext))
      expect(args).toContain('--expose-internals')
      expect(args.some(arg => arg.includes('app.asar'))).toBe(true)
      expect(environment.ELECTRON_RUN_AS_NODE).toBe('1')
      expect(environment.DSH_HOME).toEqual(expect.any(String))
    }
  })

  it('does not try to execute a cross-platform package on the build host', () => {
    const target = process.platform === 'win32' ? 'darwin' : 'win32'
    const run = vi.fn<PackagedElectronRunner>()

    smokePackagedElectronRuntime(context('/build', target), run)

    expect(run).not.toHaveBeenCalled()
  })
})

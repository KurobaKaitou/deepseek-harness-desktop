/** Private RunAsNode bootstrap for the packaged DeepSeek Harness CLI. */

import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { packagedDependencyPath } from './packaged-runtime-path.ts'
import { assertDesktopProfileName } from './profile-manager.ts'
import { withoutForwardedDesktopPnpmPolicy } from './pnpm-policy.ts'
import { installProfilePackageResolver } from './module-resolution.ts'

const RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'
const DEFAULT_PROFILE = 'DSH_DESKTOP_DEFAULT_PROFILE'
const DSH_ENTRY_URL = pathToFileURL(
  packagedDependencyPath(import.meta.url, '@deepseek-ai/dsh/lib/bin.js'),
).href

export function clearElectronRunAsNode(environment: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase() === RUN_AS_NODE) delete environment[key]
  }
}

export function withDefaultDesktopProfile(argv: readonly string[], profileName: string): string[] {
  assertDesktopProfileName(profileName)
  if (argv.some(argument => argument === '--profile' || argument.startsWith('--profile='))) return [...argv]
  const first = argv[0]
  if (first === 'web' || first === '--help' || first === '-h' || first === '--version' || first === '-V') {
    return [...argv]
  }
  if (first === 'plugin') return ['plugin', '--profile', profileName, ...argv.slice(1)]
  return ['--profile', profileName, ...argv]
}

function takeDefaultProfile(environment: NodeJS.ProcessEnv): string | undefined {
  let profileName: string | undefined
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase() !== DEFAULT_PROFILE) continue
    const value = environment[key]
    if (value !== undefined && profileName !== undefined && value !== profileName) {
      throw new Error('dsh-desktop: conflicting default profile environment values')
    }
    profileName ??= value
    delete environment[key]
  }
  return profileName
}

/** Return the Profile selected by one normalized DSH invocation. */
export function selectedDesktopCliProfile(argv: readonly string[]): string | undefined {
  if (argv[0] === 'web') return 'web'
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--profile') {
      const profile = argv[index + 1]
      if (profile !== undefined && profile.length > 0) return profile
    }
    if (argument?.startsWith('--profile=') === true) {
      const profile = argument.slice('--profile='.length)
      if (profile.length > 0) return profile
    }
  }
  return undefined
}

/**
 * Enter the packaged DSH CLI without any plugin-install transaction wrapper.
 * Manual plugin commands and Market operations rely on unified checkpoints.
 */
export async function runDesktopDshCli(
  environment: NodeJS.ProcessEnv = process.env,
  load: (url: string) => Promise<unknown> = url => import(url),
  argv: string[] = process.argv,
): Promise<void> {
  const profileName = takeDefaultProfile(environment)
  clearElectronRunAsNode(environment)
  const selected = profileName === undefined
    ? argv.slice(2)
    : withDefaultDesktopProfile(argv.slice(2), profileName)
  argv.splice(2, argv.length - 2, ...withoutForwardedDesktopPnpmPolicy(selected))
  const selectedProfile = selectedDesktopCliProfile(argv.slice(2))
  const releaseResolver = selectedProfile !== undefined
    && /([\\/])app\.asar\1/u.test(fileURLToPath(DSH_ENTRY_URL))
    ? installProfilePackageResolver(pathToFileURL(join(
      resolveProfileDir(selectedProfile, resolveDshHome(undefined, environment)),
      'package.json',
    )).href)
    : undefined
  // The DSH module finishes evaluating once a long-lived Profile is ready;
  // later HMR and Loader imports still need the same process-wide resolver.
  // Keep it until process exit rather than treating import settlement as app
  // shutdown. A packaged CLI process owns exactly one Profile invocation.
  if (releaseResolver !== undefined) process.once('exit', releaseResolver)
  await load(DSH_ENTRY_URL)
}

function isDirectExecution(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && fileURLToPath(import.meta.url) === entry
}

if (isDirectExecution()) {
  void runDesktopDshCli().catch((cause: unknown) => {
    process.stderr.write(`dsh-desktop: failed to start packaged dsh: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`)
    process.exitCode = 1
  })
}

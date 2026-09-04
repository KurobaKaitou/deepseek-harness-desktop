/** Profile-relative package resolution for Electron's restricted Node runtime. */

import Module, {
  createRequire,
  isBuiltin,
  registerHooks,
  type ModuleHooks,
  type ResolveHookSync,
} from 'node:module'
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  findOverlayPackage,
  packageNameFromSpecifier,
  PackageOverlayNotFoundError,
  type PackageOverlayCandidate,
} from './package-overlay.ts'
import { retainAsarModuleResolver } from './asar-module-resolver-state.ts'

const LOADER_ENTRY_URL = import.meta.resolve('@deepseek-ai/cordis-plugin-loader')
// Keep installation resolution in Electron's logical ASAR tree. Native
// payloads are redirected by Electron Builder, while ordinary modules avoid a
// second physical node_modules tree and its Windows antivirus I/O cost.
const DESKTOP_ENTRY_URL = pathToFileURL(fileURLToPath(new URL('../lib/index.js', import.meta.url))).href
const DESKTOP_PACKAGE_URL = pathToFileURL(fileURLToPath(new URL('../package.json', import.meta.url))).href
const DESKTOP_REQUIRE = createRequire(DESKTOP_ENTRY_URL)
const PROCESS_RESOLVER = Symbol.for('dsh-plugin-desktop.profile-package-resolver.v1')

type ModuleSource = 'install' | 'profile'

interface ProfileResolverRegistration {
  readonly profileBaseUrl: string
  readonly profileDirectory: string
  readonly sharedFallbackDirectory: string
  readonly moduleSources: Map<string, ModuleSource>
  readonly profileRequire: NodeJS.Require
  references: number
  sequence: number
}

interface ProcessResolverState {
  readonly registrations: Map<string, ProfileResolverRegistration>
  readonly hooks: ModuleHooks
  readonly commonJsModule: CommonJsModuleResolver
  readonly previousResolveFilename: CommonJsModuleResolver['_resolveFilename']
  readonly overlayResolveFilename: CommonJsModuleResolver['_resolveFilename']
  bypassDepth: number
  nextSequence: number
  resolve: ResolveHookSync
  resolveFilename: CommonJsModuleResolver['_resolveFilename']
}

interface CommonJsModuleResolver {
  _resolveFilename(
    request: string,
    parent: { filename?: string } | null | undefined,
    isMain: boolean | undefined,
    options?: unknown,
  ): string
}

type ProcessState = Record<PropertyKey, unknown>

function processState(): ProcessState {
  return globalThis as unknown as ProcessState
}

function currentResolverState(): ProcessResolverState | undefined {
  return processState()[PROCESS_RESOLVER] as ProcessResolverState | undefined
}

function setResolverState(state: ProcessResolverState | undefined): void {
  if (state === undefined) delete processState()[PROCESS_RESOLVER]
  else processState()[PROCESS_RESOLVER] = state
}

function filePath(url: string | undefined): string | undefined {
  if (url === undefined || !url.startsWith('file:')) return undefined
  try {
    return fileURLToPath(url)
  } catch {
    return undefined
  }
}

function moduleKey(url: string): string {
  const candidate = filePath(url)
  if (candidate === undefined) return url
  let canonical = candidate
  try {
    canonical = realpathSync.native(candidate)
  } catch {
    // A generated module can be observed immediately before publication.
  }
  const parsed = new URL(url)
  const normalized = pathToFileURL(canonical)
  normalized.search = parsed.search
  normalized.hash = parsed.hash
  return normalized.href
}

function canonicalPath(candidate: string): string {
  try {
    return realpathSync.native(candidate)
  } catch {
    return candidate
  }
}

function isLexicallyWithin(directory: string, candidate: string): boolean {
  const offset = relative(directory, candidate)
  return offset === '' || (offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
}

function isWithin(directory: string, candidate: string): boolean {
  return isLexicallyWithin(directory, candidate)
    || isLexicallyWithin(canonicalPath(directory), canonicalPath(candidate))
}

function isDirectProfileBoundary(registration: ProfileResolverRegistration, url: string | undefined): boolean {
  if (url === registration.profileBaseUrl) return true
  const candidate = filePath(url)
  if (candidate === undefined) return false
  const profileDirectory = canonicalPath(registration.profileDirectory)
  const offset = relative(profileDirectory, canonicalPath(candidate))
  // The native Loader has used the directory URL, package.json, and cordis
  // config files as its parentURL across supported Node releases. Restrict the
  // bridge to that directory and its direct files, never another Profile.
  return offset === '' || (!offset.includes(sep) && offset !== '..' && !isAbsolute(offset))
}

function isSharedFallbackPath(registration: ProfileResolverRegistration, candidate: string): boolean {
  return isWithin(registration.sharedFallbackDirectory, candidate)
}

function isSharedFallbackUrl(registration: ProfileResolverRegistration, url: string): boolean {
  const candidate = filePath(url)
  return candidate !== undefined && isSharedFallbackPath(registration, candidate)
}

function isLegacyDesktopInstallUrl(url: string): boolean {
  const candidate = filePath(url)
  return candidate !== undefined && /(^|[\\/])app\.asar(?:\.unpacked)?([\\/]|$)/iu.test(candidate)
}

function isObsoleteProfileFallbackUrl(
  registration: ProfileResolverRegistration,
  url: string,
): boolean {
  return isSharedFallbackUrl(registration, url) || isLegacyDesktopInstallUrl(url)
}

function isObsoleteProfileFallbackPath(
  registration: ProfileResolverRegistration,
  candidate: string,
): boolean {
  return isSharedFallbackPath(registration, candidate)
    || /(^|[\\/])app\.asar(?:\.unpacked)?([\\/]|$)/iu.test(candidate)
}

function isBarePackageSpecifier(specifier: string): boolean {
  return !isBuiltin(specifier) && packageNameFromSpecifier(specifier) !== undefined
}

function resolvablePackageName(specifier: string): string | undefined {
  return isBuiltin(specifier) ? undefined : packageNameFromSpecifier(specifier)
}

function isPackageLocalSpecifier(specifier: string): boolean {
  return specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')
    || URL.canParse(specifier)
}

function isMissingModule(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException | null)?.code
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND'
}

function newestRegistration(
  state: ProcessResolverState,
  predicate: (registration: ProfileResolverRegistration) => boolean,
): ProfileResolverRegistration | undefined {
  let selected: ProfileResolverRegistration | undefined
  for (const registration of state.registrations.values()) {
    if (predicate(registration) && (selected === undefined || registration.sequence > selected.sequence)) {
      selected = registration
    }
  }
  return selected
}

function registrationForParent(
  state: ProcessResolverState,
  parentURL: string | undefined,
): ProfileResolverRegistration | undefined {
  const exact = newestRegistration(state, registration => isDirectProfileBoundary(registration, parentURL))
  if (exact !== undefined) return exact
  const graph = newestRegistration(state, registration => (
    parentURL !== undefined && registration.moduleSources.has(moduleKey(parentURL))
  ))
  if (graph !== undefined) return graph
  // The public Loader fallback evaluates a bare dynamic import from its own
  // module. One DSH process owns one active Profile; during an HMR hand-over,
  // the most recently retained registration is authoritative.
  return parentURL === LOADER_ENTRY_URL
    ? newestRegistration(state, () => true)
    : undefined
}

function selectedOverlayCandidate(
  registration: ProfileResolverRegistration,
  packageName: string,
): PackageOverlayCandidate {
  const overlay = findOverlayPackage(packageName, {
    installPackageUrl: DESKTOP_PACKAGE_URL,
    profilePackageUrl: registration.profileBaseUrl,
  })
  if (overlay === undefined) throw new PackageOverlayNotFoundError(packageName)
  if (overlay.selected.source === 'profile'
    && !isLexicallyWithin(join(registration.profileDirectory, 'node_modules'), overlay.selected.manifestPath)) {
    // findPackageJSON follows Node's ordinary ancestor walk. Only the exact
    // active Profile node_modules tree is an overlay candidate; accepting a
    // package from $DSH_HOME/node_modules would let unrelated/stale state
    // override the sealed Desktop installation. Keep this check lexical so a
    // Profile-owned node_modules symlink into .dsh-module-fallback remains
    // valid while packages above the Profile boundary do not.
    if (overlay.install !== undefined) return overlay.install
    throw new PackageOverlayNotFoundError(packageName)
  }
  if (overlay.selected.source !== 'profile'
    || !isSharedFallbackPath(registration, overlay.selected.manifestPath)) {
    return overlay.selected
  }
  // Older Desktop releases populated profiles/node_modules with an
  // installation-wide proxy/link tree. It is not an active Profile candidate:
  // using it can resurrect a dangling path or a previous app generation.
  if (overlay.install !== undefined) return overlay.install
  throw new PackageOverlayNotFoundError(packageName)
}

function track(
  registration: ProfileResolverRegistration,
  url: string,
  source: ModuleSource,
): void {
  registration.moduleSources.set(moduleKey(url), source)
}

function resolveFromAnchor(
  state: ProcessResolverState,
  registration: ProfileResolverRegistration,
  specifier: string,
  source: ModuleSource,
  context: Parameters<ResolveHookSync>[1],
  nextResolve: Parameters<ResolveHookSync>[2],
): ReturnType<ResolveHookSync> {
  if (!context.conditions?.includes('require')) {
    return nextResolve(specifier, {
      ...context,
      parentURL: source === 'profile' ? registration.profileBaseUrl : DESKTOP_ENTRY_URL,
    })
  }
  // Node's synchronous hook observes require/createRequire, but its CJS
  // default resolver intentionally keeps the original CJS parent even when a
  // hook changes context.parentURL. Resolve that branch with Node's official
  // createRequire API and short-circuit only this request. The bypass prevents
  // the nested require.resolve call from re-entering our own policy.
  state.bypassDepth += 1
  try {
    const require = source === 'profile' ? registration.profileRequire : DESKTOP_REQUIRE
    return {
      url: pathToFileURL(require.resolve(specifier)).href,
      shortCircuit: true,
    }
  } finally {
    state.bypassDepth -= 1
  }
}

function resolveCommonJsFromAnchor(
  state: ProcessResolverState,
  registration: ProfileResolverRegistration,
  request: string,
  source: ModuleSource,
): string {
  state.bypassDepth += 1
  try {
    const require = source === 'profile' ? registration.profileRequire : DESKTOP_REQUIRE
    return require.resolve(request)
  } finally {
    state.bypassDepth -= 1
  }
}

function resolveFilenameWithState(
  state: ProcessResolverState,
  thisArg: CommonJsModuleResolver,
  request: string,
  parent: { filename?: string } | null | undefined,
  isMain: boolean | undefined,
  options?: unknown,
): string {
  if (state.bypassDepth > 0) {
    return state.previousResolveFilename.call(thisArg, request, parent, isMain, options)
  }
  const parentURL = parent?.filename === undefined ? undefined : pathToFileURL(parent.filename).href
  const registration = registrationForParent(state, parentURL)
  const packageName = resolvablePackageName(request)
  if (registration === undefined || packageName === undefined) {
    return state.previousResolveFilename.call(thisArg, request, parent, isMain, options)
  }
  const fromBoundary = isDirectProfileBoundary(registration, parentURL)
    || parentURL === LOADER_ENTRY_URL
  if (fromBoundary) {
    const selected = selectedOverlayCandidate(registration, packageName)
    const resolved = resolveCommonJsFromAnchor(state, registration, request, selected.source)
    if (selected.source === 'profile' && isObsoleteProfileFallbackPath(registration, resolved)) {
      throw new PackageOverlayNotFoundError(packageName)
    }
    track(registration, pathToFileURL(resolved).href, selected.source)
    return resolved
  }
  const parentSource = parentURL === undefined
    ? undefined
    : registration.moduleSources.get(moduleKey(parentURL))
  if (parentSource === undefined) {
    return state.previousResolveFilename.call(thisArg, request, parent, isMain, options)
  }
  try {
    const resolved = state.previousResolveFilename.call(thisArg, request, parent, isMain, options)
    if (parentSource === 'install' || !isObsoleteProfileFallbackPath(registration, resolved)) {
      track(registration, pathToFileURL(resolved).href, parentSource)
      return resolved
    }
  } catch (cause) {
    if (!isMissingModule(cause)) throw cause
  }
  try {
    const resolved = resolveCommonJsFromAnchor(state, registration, request, 'profile')
    if (!isObsoleteProfileFallbackPath(registration, resolved)) {
      track(registration, pathToFileURL(resolved).href, 'profile')
      return resolved
    }
  } catch (cause) {
    if (!isMissingModule(cause)) throw cause
  }
  const resolved = resolveCommonJsFromAnchor(state, registration, request, 'install')
  track(registration, pathToFileURL(resolved).href, 'install')
  return resolved
}

function resolveForRegistration(
  state: ProcessResolverState,
  registration: ProfileResolverRegistration,
  specifier: string,
  context: Parameters<ResolveHookSync>[1],
  nextResolve: Parameters<ResolveHookSync>[2],
): ReturnType<ResolveHookSync> {
  const fromBoundary = isDirectProfileBoundary(registration, context.parentURL)
    || context.parentURL === LOADER_ENTRY_URL
  const packageName = fromBoundary ? resolvablePackageName(specifier) : undefined
  if (packageName !== undefined) {
    const selected = selectedOverlayCandidate(registration, packageName)
    const source = selected.source
    const resolved = resolveFromAnchor(state, registration, specifier, source, context, nextResolve)
    if (source === 'profile' && isObsoleteProfileFallbackUrl(registration, resolved.url)) {
      throw new PackageOverlayNotFoundError(packageName)
    }
    track(registration, resolved.url, source)
    return resolved
  }

  const parentSource = context.parentURL === undefined
    ? undefined
    : registration.moduleSources.get(moduleKey(context.parentURL))
  if (parentSource === undefined) return nextResolve(specifier, context)

  // Relative paths, package imports, absolute URLs and builtins belong to the
  // selected package. Do not reinterpret them through another package anchor.
  if (isPackageLocalSpecifier(specifier) || !isBarePackageSpecifier(specifier)) {
    const resolved = nextResolve(specifier, context)
    if (resolved.url.startsWith('file:')) track(registration, resolved.url, parentSource)
    return resolved
  }

  try {
    const resolved = nextResolve(specifier, context)
    if (parentSource === 'install' || !isObsoleteProfileFallbackUrl(registration, resolved.url)) {
      track(registration, resolved.url, parentSource)
      return resolved
    }
  } catch (cause) {
    if (!isMissingModule(cause)) throw cause
  }

  try {
    const resolved = resolveFromAnchor(state, registration, specifier, 'profile', context, nextResolve)
    if (!isObsoleteProfileFallbackUrl(registration, resolved.url)) {
      track(registration, resolved.url, 'profile')
      return resolved
    }
  } catch (cause) {
    if (!isMissingModule(cause)) throw cause
  }

  // Delegating the original context preserves Node's import/require
  // conditions, wildcard and exact exports, package.json exports, and CJS
  // callable identity. Only the parent anchor changes.
  const resolved = resolveFromAnchor(state, registration, specifier, 'install', context, nextResolve)
  track(registration, resolved.url, 'install')
  return resolved
}

function resolveWithState(
  state: ProcessResolverState,
  specifier: string,
  context: Parameters<ResolveHookSync>[1],
  nextResolve: Parameters<ResolveHookSync>[2],
): ReturnType<ResolveHookSync> {
  if (state.bypassDepth > 0) return nextResolve(specifier, context)
  const registration = registrationForParent(state, context.parentURL)
  return registration === undefined
    ? nextResolve(specifier, context)
    : resolveForRegistration(state, registration, specifier, context, nextResolve)
}

function ensureResolverState(): ProcessResolverState {
  const existing = currentResolverState()
  if (existing !== undefined) {
    // A hook registered by an earlier HMR generation delegates through this
    // mutable function, so it immediately adopts the current implementation.
    existing.resolve = (specifier, context, nextResolve) => (
      resolveWithState(existing, specifier, context, nextResolve)
    )
    existing.resolveFilename = function (this: CommonJsModuleResolver, request, parent, isMain, options) {
      return resolveFilenameWithState(existing, this, request, parent, isMain, options)
    }
    return existing
  }
  const commonJsModule = Module as unknown as CommonJsModuleResolver
  const previousResolveFilename = commonJsModule._resolveFilename
  const state = {
    registrations: new Map<string, ProfileResolverRegistration>(),
    bypassDepth: 0,
    nextSequence: 0,
    resolve: ((specifier, context, nextResolve) => nextResolve(specifier, context)) as ResolveHookSync,
    resolveFilename: previousResolveFilename,
  } as ProcessResolverState
  const hooks = registerHooks({
    resolve: (specifier, context, nextResolve) => state.resolve(specifier, context, nextResolve),
  })
  Object.defineProperty(state, 'hooks', { value: hooks, enumerable: true })
  const overlayResolveFilename: CommonJsModuleResolver['_resolveFilename'] = function (
    this: CommonJsModuleResolver,
    request,
    parent,
    isMain,
    options,
  ) {
    return state.resolveFilename.call(this, request, parent, isMain, options)
  }
  Object.defineProperties(state, {
    commonJsModule: { value: commonJsModule, enumerable: true },
    previousResolveFilename: { value: previousResolveFilename, enumerable: true },
    overlayResolveFilename: { value: overlayResolveFilename, enumerable: true },
  })
  state.resolve = (specifier, context, nextResolve) => (
    resolveWithState(state, specifier, context, nextResolve)
  )
  state.resolveFilename = function (this: CommonJsModuleResolver, request, parent, isMain, options) {
    return resolveFilenameWithState(state, this, request, parent, isMain, options)
  }
  commonJsModule._resolveFilename = overlayResolveFilename
  setResolverState(state)
  return state
}

/**
 * Resolve Cordis Loader imports from one selected persistent Profile.
 * The process owns one multiplexed Node hook; repeated/HMR registrations are
 * reference-counted and may be released in any order.
 * @param profileBaseUrl - file URL for the Profile package.json.
 * @returns an idempotent registration disposer.
 */
export function installProfilePackageResolver(profileBaseUrl: string): () => void {
  const parsed = new URL(profileBaseUrl)
  if (parsed.protocol !== 'file:' || parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error('dsh-plugin-desktop: Profile package resolver requires a plain file URL')
  }
  const profileManifestPath = fileURLToPath(parsed)
  if (basename(profileManifestPath) !== 'package.json') {
    throw new Error('dsh-plugin-desktop: Profile package resolver requires a package.json anchor')
  }
  const normalizedBaseUrl = pathToFileURL(profileManifestPath).href
  const profileDirectory = dirname(profileManifestPath)
  const state = ensureResolverState()
  let registration = state.registrations.get(normalizedBaseUrl)
  if (registration === undefined) {
    registration = {
      profileBaseUrl: normalizedBaseUrl,
      profileDirectory,
      sharedFallbackDirectory: join(dirname(profileDirectory), 'node_modules'),
      moduleSources: new Map(),
      profileRequire: createRequire(normalizedBaseUrl),
      references: 0,
      sequence: 0,
    }
    state.registrations.set(normalizedBaseUrl, registration)
  }
  registration.references += 1
  registration.sequence = ++state.nextSequence
  const releaseMarker = retainAsarModuleResolver()
  let active = true
  return () => {
    if (!active) return
    active = false
    releaseMarker()
    registration!.references -= 1
    if (registration!.references === 0) state.registrations.delete(normalizedBaseUrl)
    if (state.registrations.size > 0) return
    state.hooks.deregister()
    if (state.commonJsModule._resolveFilename === state.overlayResolveFilename) {
      state.commonJsModule._resolveFilename = state.previousResolveFilename
    }
    if (currentResolverState() === state) setResolverState(undefined)
  }
}

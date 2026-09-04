import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const harness = vi.hoisted(() => {
  const cjsOriginal = vi.fn((
    request: string,
    _parent?: { filename?: string } | null,
    _isMain?: boolean,
    _options?: unknown,
  ) => `ordinary:${request}`)
  const registerHooks = vi.fn((definition: { resolve: typeof harness.resolve }) => {
    harness.resolve = definition.resolve
    return { deregister: harness.deregister }
  })
  return {
    resolve: undefined as undefined | ((
      specifier: string,
      context: { parentURL?: string },
      nextResolve: (specifier: string, context: { parentURL?: string }) => unknown,
    ) => unknown),
    deregister: vi.fn(),
    sources: new Map<string, 'install' | 'profile'>(),
    overlay: vi.fn((packageName: string, options: { profilePackageUrl: string }) => {
      const source = harness.sources.get(packageName) ?? 'profile'
      const selected = {
        source,
        manifestPath: source === 'profile'
          ? join(
              dirname(fileURLToPath(options.profilePackageUrl)),
              'node_modules',
              ...packageName.split('/'),
              'package.json',
            )
          : `/install/${packageName}/package.json`,
      }
      return {
        packageName,
        selected,
        [source]: selected,
      }
    }),
    registerHooks,
    cjsOriginal,
    cjsModule: { _resolveFilename: cjsOriginal },
  }
})

vi.mock('node:module', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:module')>(),
  default: harness.cjsModule,
  registerHooks: harness.registerHooks,
}))

vi.mock('../src/package-overlay.ts', () => ({
  PackageOverlayNotFoundError: class PackageOverlayNotFoundError extends Error {},
  findOverlayPackage: harness.overlay,
  packageNameFromSpecifier(specifier: string): string | undefined {
    if (specifier.length === 0 || specifier.startsWith('.') || specifier.startsWith('/')
      || specifier.startsWith('#') || URL.canParse(specifier)) return undefined
    const parts = specifier.split('/')
    return specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
  },
  resolveOverlayPackage: harness.overlay,
}))

const { installProfilePackageResolver: retainProfilePackageResolver } = await import('../src/module-resolution.ts')
const releases: Array<() => void> = []

function installProfilePackageResolver(profileBaseUrl: string): () => void {
  const release = retainProfilePackageResolver(profileBaseUrl)
  releases.push(release)
  return release
}

function missing(specifier: string, parentURL?: string): Error {
  return Object.assign(
    new Error(`Cannot find package '${specifier}' imported from ${parentURL ?? 'unknown'}`),
    { code: 'ERR_MODULE_NOT_FOUND' },
  )
}

describe('installProfilePackageResolver', () => {
  beforeEach(() => {
    harness.resolve = undefined
    harness.deregister.mockClear()
    harness.overlay.mockClear()
    harness.sources.clear()
    harness.registerHooks.mockClear()
    harness.cjsOriginal.mockClear()
    harness.cjsModule._resolveFilename = harness.cjsOriginal
  })

  afterEach(() => {
    for (const release of releases.splice(0).reverse()) release()
  })

  it('uses the overlay-selected side for every Loader package and subpath', () => {
    const profileBaseUrl = 'file:///C:/Users/test/profile/package.json'
    harness.sources.set('@deepseek-ai/dsh-web-app', 'install')
    harness.sources.set('dsh-plugin-desktop', 'profile')
    installProfilePackageResolver(profileBaseUrl)
    const nextResolve = vi.fn((specifier: string, context: { parentURL?: string }) => ({ specifier, context }))
    const loaderEntryUrl = import.meta.resolve('@deepseek-ai/cordis-plugin-loader')

    const installed = harness.resolve?.(
      '@deepseek-ai/dsh-web-app',
      { parentURL: profileBaseUrl },
      nextResolve,
    ) as { context: { parentURL?: string } }
    expect(installed.context.parentURL).not.toBe(profileBaseUrl)
    expect(installed.context.parentURL).toMatch(/\/lib\/index\.js$/u)

    expect(harness.resolve?.(
      'dsh-plugin-desktop/profile',
      { parentURL: loaderEntryUrl },
      nextResolve,
    )).toEqual({
      specifier: 'dsh-plugin-desktop/profile',
      context: { parentURL: profileBaseUrl },
    })
    expect(harness.overlay).toHaveBeenCalledWith('@deepseek-ai/dsh-web-app', expect.any(Object))
    expect(harness.overlay).toHaveBeenCalledWith('dsh-plugin-desktop', expect.any(Object))
  })

  it('also recognizes the Loader native dynamic-import fallback', () => {
    const profileBaseUrl = 'file:///C:/Users/test/profile/package.json'
    installProfilePackageResolver(profileBaseUrl)
    const nextResolve = vi.fn((specifier: string, context: { parentURL?: string }) => ({ specifier, context }))
    const loaderEntryUrl = import.meta.resolve('@deepseek-ai/cordis-plugin-loader')

    expect(harness.resolve?.(
      '@deepseek-ai/dsh-web-app',
      { parentURL: loaderEntryUrl },
      nextResolve,
    )).toEqual({
      specifier: '@deepseek-ai/dsh-web-app',
      context: { parentURL: profileBaseUrl },
    })
  })

  it('recognizes the clean-boot Profile directory URL as a Loader boundary', () => {
    const profileBaseUrl = 'file:///tmp/dsh/profiles/desktop/package.json'
    installProfilePackageResolver(profileBaseUrl)
    const nextResolve = vi.fn((specifier: string, context: { parentURL?: string }) => ({ specifier, context }))

    expect(harness.resolve?.(
      '@deepseek-ai/dsh-web-app',
      { parentURL: 'file:///tmp/dsh/profiles/desktop/' },
      nextResolve,
    )).toEqual({
      specifier: '@deepseek-ai/dsh-web-app',
      context: { parentURL: profileBaseUrl },
    })
    expect(harness.overlay).toHaveBeenCalledWith('@deepseek-ai/dsh-web-app', expect.any(Object))
  })

  it('keeps non-package Loader specifiers on ordinary Node resolution', () => {
    installProfilePackageResolver('file:///C:/Users/test/profile/package.json')
    const nextResolve = vi.fn((specifier: string, context: { parentURL?: string }) => ({ specifier, context }))
    const loaderEntryUrl = import.meta.resolve('@deepseek-ai/cordis-plugin-loader')

    expect(harness.resolve?.('./relative.js', { parentURL: loaderEntryUrl }, nextResolve)).toEqual({
      specifier: './relative.js',
      context: { parentURL: loaderEntryUrl },
    })
    expect(harness.resolve?.('cordis:include', { parentURL: loaderEntryUrl }, nextResolve)).toEqual({
      specifier: 'cordis:include',
      context: { parentURL: loaderEntryUrl },
    })
    expect(harness.overlay).not.toHaveBeenCalled()
  })

  it('keeps package-local dependencies and Profile fallback across linked relative modules', () => {
    const profileBaseUrl = 'file:///C:/Users/test/profile/package.json'
    const linkedPluginUrl = 'file:///D:/workspace/plugins/dsh-linked/lib/index.js'
    const linkedFeatureUrl = 'file:///D:/workspace/plugins/dsh-linked/lib/feature.js'
    const localDependencyUrl = 'file:///D:/workspace/plugins/dsh-linked/node_modules/local-dependency/index.js'
    const profilePeerUrl = 'file:///C:/Users/test/profile/node_modules/profile-peer/index.js'
    installProfilePackageResolver(profileBaseUrl)
    const nextResolve = vi.fn((specifier: string, context: { parentURL?: string }) => {
      if (specifier === 'dsh-linked' && context.parentURL === profileBaseUrl) return { url: linkedPluginUrl }
      if (specifier === './feature.js' && context.parentURL === linkedPluginUrl) return { url: linkedFeatureUrl }
      if (specifier === 'local-dependency' && context.parentURL === linkedFeatureUrl) return { url: localDependencyUrl }
      if (specifier === 'profile-peer' && context.parentURL === profileBaseUrl) return { url: profilePeerUrl }
      throw missing(specifier, context.parentURL)
    })
    const loaderEntryUrl = import.meta.resolve('@deepseek-ai/cordis-plugin-loader')

    expect(harness.resolve?.('dsh-linked', { parentURL: loaderEntryUrl }, nextResolve)).toEqual({ url: linkedPluginUrl })
    expect(harness.resolve?.('./feature.js', { parentURL: linkedPluginUrl }, nextResolve)).toEqual({ url: linkedFeatureUrl })
    expect(harness.resolve?.('local-dependency', { parentURL: linkedFeatureUrl }, nextResolve)).toEqual({ url: localDependencyUrl })
    expect(harness.resolve?.('profile-peer', { parentURL: localDependencyUrl }, nextResolve)).toEqual({ url: profilePeerUrl })
  })

  it('allows a Desktop-selected package to use a missing dependency from the Profile overlay', () => {
    const profileBaseUrl = 'file:///C:/Users/test/profile/package.json'
    const desktopPluginUrl = 'file:///Applications/DSH.app/Contents/Resources/app.asar/node_modules/plugin/index.js'
    const profilePeerUrl = 'file:///C:/Users/test/profile/node_modules/profile-peer/index.js'
    harness.sources.set('plugin', 'install')
    installProfilePackageResolver(profileBaseUrl)
    const nextResolve = vi.fn((specifier: string, context: { parentURL?: string }) => {
      if (specifier === 'plugin' && context.parentURL?.endsWith('/lib/index.js')) return { url: desktopPluginUrl }
      if (specifier === 'profile-peer' && context.parentURL === profileBaseUrl) return { url: profilePeerUrl }
      throw missing(specifier, context.parentURL)
    })
    const loaderEntryUrl = import.meta.resolve('@deepseek-ai/cordis-plugin-loader')

    expect(harness.resolve?.('plugin', { parentURL: loaderEntryUrl }, nextResolve)).toEqual({ url: desktopPluginUrl })
    expect(harness.resolve?.('profile-peer', { parentURL: desktopPluginUrl }, nextResolve)).toEqual({ url: profilePeerUrl })
  })

  it('falls back to the Desktop installation after CommonJS-style misses', () => {
    const profileBaseUrl = 'file:///tmp/dsh/profiles/desktop/package.json'
    const pluginUrl = 'file:///tmp/dsh/profiles/desktop/node_modules/plugin/index.cjs'
    const desktopDependencyUrl = 'file:///Applications/DSH.app/Contents/Resources/app.asar/node_modules/dependency/index.cjs'
    installProfilePackageResolver(profileBaseUrl)
    const nextResolve = vi.fn((specifier: string, context: { parentURL?: string }) => {
      if (specifier === 'plugin' && context.parentURL === profileBaseUrl) return { url: pluginUrl }
      if (specifier === 'dependency' && context.parentURL?.endsWith('/lib/index.js')) {
        return { url: desktopDependencyUrl }
      }
      throw Object.assign(new Error(`missing ${specifier}`), { code: 'MODULE_NOT_FOUND' })
    })

    expect(harness.resolve?.('plugin', { parentURL: profileBaseUrl }, nextResolve)).toEqual({ url: pluginUrl })
    expect(harness.resolve?.('dependency', { parentURL: pluginUrl }, nextResolve))
      .toEqual({ url: desktopDependencyUrl })
  })

  it('bypasses an obsolete shared Profile proxy before using the Desktop package', () => {
    const profileBaseUrl = 'file:///tmp/dsh/profiles/desktop/package.json'
    const pluginUrl = 'file:///tmp/dsh/profiles/desktop/node_modules/plugin/index.cjs'
    const staleUrl = 'file:///tmp/dsh/profiles/node_modules/@deepseek-ai/schemastery/index.js'
    const desktopUrl = 'file:///Applications/DSH.app/Contents/Resources/app.asar/node_modules/@deepseek-ai/schemastery/lib/index.cjs'
    installProfilePackageResolver(profileBaseUrl)
    const nextResolve = vi.fn((specifier: string, context: { parentURL?: string }) => {
      if (specifier === 'plugin' && context.parentURL === profileBaseUrl) return { url: pluginUrl }
      if (specifier === '@deepseek-ai/schemastery' && context.parentURL?.endsWith('/lib/index.js')) {
        return { url: desktopUrl }
      }
      return { url: staleUrl }
    })

    expect(harness.resolve?.('plugin', { parentURL: profileBaseUrl }, nextResolve)).toEqual({ url: pluginUrl })
    expect(harness.resolve?.('@deepseek-ai/schemastery', { parentURL: pluginUrl }, nextResolve))
      .toEqual({ url: desktopUrl })
    expect(nextResolve).toHaveBeenCalledTimes(4)
  })

  it('does not expose Profile dependencies to unrelated modules', () => {
    const profileBaseUrl = 'file:///C:/Users/test/profile/package.json'
    installProfilePackageResolver(profileBaseUrl)
    const nextResolve = vi.fn((specifier: string, context: { parentURL?: string }) => {
      if (context.parentURL === profileBaseUrl) return { url: 'file:///C:/Users/test/profile/node_modules/zod/index.js' }
      throw missing(specifier, context.parentURL)
    })

    expect(() => harness.resolve?.(
      'zod',
      { parentURL: 'file:///C:/Program%20Files/DSH%20Desktop/resources/app.asar/lib/main.js' },
      nextResolve,
    )).toThrow('Cannot find package')
    expect(nextResolve).toHaveBeenCalledTimes(1)
  })

  it('uses the same hook and overlay for CommonJS package manifests from Profile anchors', () => {
    const profileManifestPath = join(tmpdir(), 'dsh-profile', 'package.json')
    const profileConfigPath = join(tmpdir(), 'dsh-profile', 'cordis.yml')
    const profileBaseUrl = pathToFileURL(profileManifestPath).href
    harness.sources.set('@deepseek-ai/dsh-client-modules', 'install')
    installProfilePackageResolver(profileBaseUrl)
    const resolveFilename = harness.cjsModule._resolveFilename
    expect(resolveFilename(
      '@deepseek-ai/dsh-client-modules/package.json',
      { filename: profileManifestPath },
      false,
    )).toMatch(/node_modules[\\/]@deepseek-ai[\\/]dsh-client-modules[\\/]package\.json$/u)
    expect(resolveFilename(
      '@deepseek-ai/dsh-client-modules/package.json',
      { filename: profileConfigPath },
      false,
    )).toMatch(/node_modules[\\/]@deepseek-ai[\\/]dsh-client-modules[\\/]package\.json$/u)
    expect(resolveFilename(
      '@deepseek-ai/dsh-client-modules/package.json',
      { filename: join(tmpdir(), 'another-profile', 'package.json') },
      false,
    )).toBe('ordinary:@deepseek-ai/dsh-client-modules/package.json')
  })

  it('deregisters hooks only once even if the disposer is reused', () => {
    const dispose = installProfilePackageResolver('file:///C:/Users/test/profile/package.json')
    dispose()
    dispose()
    expect(harness.deregister).toHaveBeenCalledTimes(1)
    expect(harness.cjsModule._resolveFilename).toBe(harness.cjsOriginal)
  })

  it('multiplexes Profiles through one hook and tolerates out-of-order release', () => {
    const first = installProfilePackageResolver('file:///tmp/dsh/profiles/first/package.json')
    const second = installProfilePackageResolver('file:///tmp/dsh/profiles/second/package.json')
    expect(harness.registerHooks).toHaveBeenCalledTimes(1)

    first()
    expect(harness.deregister).not.toHaveBeenCalled()
    const nextResolve = vi.fn((specifier: string, context: { parentURL?: string }) => ({ specifier, context }))
    expect(harness.resolve?.(
      'second-plugin',
      { parentURL: 'file:///tmp/dsh/profiles/second/' },
      nextResolve,
    )).toEqual({
      specifier: 'second-plugin',
      context: { parentURL: 'file:///tmp/dsh/profiles/second/package.json' },
    })

    second()
    expect(harness.deregister).toHaveBeenCalledTimes(1)
    expect(harness.cjsModule._resolveFilename).toBe(harness.cjsOriginal)
  })

  it('reference-counts duplicate Profile registrations', () => {
    const first = installProfilePackageResolver('file:///tmp/dsh/profiles/desktop/package.json')
    const second = installProfilePackageResolver('file:///tmp/dsh/profiles/desktop/package.json')
    expect(harness.registerHooks).toHaveBeenCalledTimes(1)
    second()
    expect(harness.deregister).not.toHaveBeenCalled()
    first()
    expect(harness.deregister).toHaveBeenCalledTimes(1)
  })

  it('requires a plain package.json file URL anchor', () => {
    expect(() => installProfilePackageResolver('https://example.com/package.json'))
      .toThrow('plain file URL')
    expect(() => installProfilePackageResolver('file:///tmp/profile/cordis.yml'))
      .toThrow('package.json anchor')
    expect(() => installProfilePackageResolver('file:///tmp/profile/package.json?generation=1'))
      .toThrow('plain file URL')
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { electronPlatformStrategy } from '../src/electron-platform.ts'
import type { MenuItemConstructorOptions } from 'electron'

const electron = vi.hoisted(() => ({
  app: {
    dock: {
      setIcon: vi.fn(),
    },
    getPreferredSystemLanguages: vi.fn(() => ['en-US']),
  },
  Menu: {
    buildFromTemplate: vi.fn((_template: unknown) => ({ popup: vi.fn() })),
    setApplicationMenu: vi.fn(),
  },
}))

vi.mock('electron', () => ({
  app: electron.app,
  Menu: electron.Menu,
}))

interface RecordedContextMenuParams {
  readonly isEditable: boolean
  readonly selectionText: string
  readonly editFlags: {
    readonly canCut: boolean
    readonly canCopy: boolean
    readonly canPaste: boolean
    readonly canSelectAll: boolean
  }
}

function createWindow(): {
  readonly removeMenu: ReturnType<typeof vi.fn>
  readonly setBackgroundMaterial: ReturnType<typeof vi.fn>
  readonly contextMenuHandlers: Array<(event: unknown, parameters: RecordedContextMenuParams) => void>
} {
  const contextMenuHandlers: Array<(event: unknown, parameters: RecordedContextMenuParams) => void> = []
  return {
    removeMenu: vi.fn(),
    setBackgroundMaterial: vi.fn(),
    contextMenuHandlers,
    webContents: {
      on: vi.fn((event: string, handler: (event: unknown, parameters: RecordedContextMenuParams) => void) => {
        if (event === 'context-menu') contextMenuHandlers.push(handler)
      }),
    },
  } as never
}

function editFlags(overrides: Partial<RecordedContextMenuParams['editFlags']> = {}): RecordedContextMenuParams['editFlags'] {
  return { canCut: true, canCopy: true, canPaste: true, canSelectAll: true, ...overrides }
}

describe('electronPlatformStrategy', () => {
  beforeEach(() => {
    electron.app.dock.setIcon.mockClear()
    electron.app.getPreferredSystemLanguages.mockClear()
    electron.Menu.buildFromTemplate.mockClear()
    electron.Menu.setApplicationMenu.mockClear()
  })

  it('selects the Windows adapter and configures native window chrome', () => {
    const strategy = electronPlatformStrategy('win32')
    const window = createWindow()
    const icon = {} as Parameters<typeof strategy.configureApplication>[0]

    expect(strategy.platform).toBe('win32')
    expect(strategy.updateDownloadPlatform).toBe('win32')
    expect(strategy.canPickDirectory).toBe(true)
    expect(strategy.canToggleShellMode).toBe(true)

    strategy.configureApplication(icon, 'DSH Desktop')
    strategy.configureWindow(window as never)
    strategy.refreshThemeMaterial(window as never, 'mica')

    expect(electron.app.dock.setIcon).not.toHaveBeenCalled()
    expect(electron.Menu.setApplicationMenu).not.toHaveBeenCalled()
    expect(window.removeMenu).toHaveBeenCalledTimes(1)
    expect(window.setBackgroundMaterial.mock.calls).toEqual([
      ['mica'],
    ])
  })

  it('selects the macOS adapter and configures its native application chrome', () => {
    const strategy = electronPlatformStrategy('darwin')
    const window = createWindow()
    const icon = {} as Parameters<typeof strategy.configureApplication>[0]

    expect(strategy.platform).toBe('darwin')
    expect(strategy.updateDownloadPlatform).toBe('darwin')
    expect(strategy.canPickDirectory).toBe(false)
    expect(strategy.canToggleShellMode).toBe(true)

    strategy.configureApplication(icon, 'DSH Desktop')
    strategy.configureWindow(window as never)
    strategy.refreshThemeMaterial(window as never, 'transparent')

    expect(electron.app.dock.setIcon).toHaveBeenCalledWith(icon)
    expect(electron.Menu.buildFromTemplate).toHaveBeenCalledTimes(1)
    expect(electron.Menu.setApplicationMenu).toHaveBeenCalledTimes(1)
    expect(window.removeMenu).not.toHaveBeenCalled()
    expect(window.setBackgroundMaterial).not.toHaveBeenCalled()
  })

  it('selects the Linux adapter without desktop chrome tweaks', () => {
    const strategy = electronPlatformStrategy('linux')
    const window = createWindow()

    expect(strategy.platform).toBe('linux')
    expect(strategy.updateDownloadPlatform).toBeUndefined()
    expect(strategy.canPickDirectory).toBe(false)
    expect(strategy.canToggleShellMode).toBe(false)

    strategy.configureApplication({} as never, 'DSH Desktop')
    strategy.configureWindow(window as never)
    strategy.refreshThemeMaterial(window as never, 'off')

    expect(electron.app.dock.setIcon).not.toHaveBeenCalled()
    expect(electron.Menu.setApplicationMenu).not.toHaveBeenCalled()
    expect(window.removeMenu).not.toHaveBeenCalled()
    expect(window.setBackgroundMaterial).not.toHaveBeenCalled()
  })

  it('rejects unsupported platforms', () => {
    expect(() => electronPlatformStrategy('aix')).toThrow('unsupported Electron platform aix')
  })

  it('pops a localized text context menu for editable targets on Windows', () => {
    const strategy = electronPlatformStrategy('win32')
    const window = createWindow()

    strategy.configureWindow(window as never)

    expect(window.contextMenuHandlers).toHaveLength(1)
    window.contextMenuHandlers[0]!(undefined, {
      isEditable: true,
      selectionText: '',
      editFlags: editFlags(),
    })

    const template = electron.Menu.buildFromTemplate.mock.calls.at(-1)?.[0] as unknown as MenuItemConstructorOptions[]
    expect(template).toEqual([
      { label: 'Cut', role: 'cut' },
      { label: 'Copy', role: 'copy' },
      { label: 'Paste', role: 'paste' },
      { type: 'separator' },
      { label: 'Select All', role: 'selectAll' },
    ])
    const built = electron.Menu.buildFromTemplate.mock.results.at(-1)!.value as {
      popup: ReturnType<typeof vi.fn>
    }
    expect(built.popup).toHaveBeenCalledWith({ window: window as never })
  })

  it('pops only a copy menu for non-editable selections on Windows', () => {
    const strategy = electronPlatformStrategy('win32')
    const window = createWindow()

    strategy.configureWindow(window as never)
    window.contextMenuHandlers[0]!(undefined, {
      isEditable: false,
      selectionText: 'already selected answer',
      editFlags: editFlags({ canCut: false, canPaste: false }),
    })

    expect(electron.Menu.buildFromTemplate.mock.calls.at(-1)?.[0]).toEqual([
      { label: 'Copy', role: 'copy' },
      { type: 'separator' },
      { label: 'Select All', role: 'selectAll' },
    ])  })

  it('skips the context menu popup on plain Windows content', () => {
    const strategy = electronPlatformStrategy('win32')
    const window = createWindow()

    strategy.configureWindow(window as never)
    window.contextMenuHandlers[0]!(undefined, {
      isEditable: false,
      selectionText: '',
      editFlags: editFlags(),
    })

    expect(electron.Menu.buildFromTemplate).not.toHaveBeenCalled()
  })

  it('does not register a context menu on the macOS adapter', () => {
    const strategy = electronPlatformStrategy('darwin')
    const window = createWindow()

    strategy.configureWindow(window as never)

    expect(window.contextMenuHandlers).toHaveLength(0)
  })
})

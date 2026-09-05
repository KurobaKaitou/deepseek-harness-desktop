import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertDesktopFactoryResetTarget,
  resetDesktopDataDirectory,
} from '../src/desktop-factory-reset.ts'

const roots: string[] = []

async function fixture(): Promise<{ readonly root: string; readonly home: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-beta-factory-reset-'))
  roots.push(root)
  const home = join(root, '.dsh')
  mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'desktop', 'package.json'), '{}\n')
  writeFileSync(join(home, 'session.jsonl'), '{}\n')
  return { root, home }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => { await rm(root, { recursive: true, force: true }) }))
})

describe('Desktop factory reset', () => {
  it('moves only the validated DSH Home to trash and recreates an empty root', async () => {
    const { root, home } = await fixture()
    const trashed = join(root, 'trashed-dsh')
    const trashItem = vi.fn(async (path: string) => { await rename(path, trashed) })

    await expect(resetDesktopDataDirectory({
      homeDir: home,
      protectedPaths: [root, join(root, 'desktop-state')],
      trashItem,
    })).resolves.toBe(home)

    expect(trashItem).toHaveBeenCalledWith(home)
    expect(existsSync(join(trashed, 'session.jsonl'))).toBe(true)
    expect(existsSync(home)).toBe(true)
    expect(existsSync(join(home, 'profiles'))).toBe(false)
  })

  it('rejects roots, symlinks, uninitialized directories, and protected ancestors', async () => {
    const { root, home } = await fixture()
    expect(() => assertDesktopFactoryResetTarget('/', [root], 'darwin')).toThrow('filesystem root')
    expect(() => assertDesktopFactoryResetTarget(root, [join(root, 'desktop-state')], 'darwin'))
      .toThrow('contains protected')
    const empty = join(root, 'empty')
    mkdirSync(empty)
    expect(() => assertDesktopFactoryResetTarget(empty, [root], 'darwin')).toThrow('not an initialized DSH Home')
    expect(assertDesktopFactoryResetTarget(home, [root], 'darwin')).toBe(home)
  })
})

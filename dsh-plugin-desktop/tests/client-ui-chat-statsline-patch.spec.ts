import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const patch = readFileSync(new URL(
  '../../patches/dsh-client-ui-chat@0.1.2-alpha.1.patch',
  import.meta.url,
), 'utf8')

const removedLines = patch.split('\n').filter(line => line.startsWith('-') && !line.startsWith('---'))
const addedLines = patch.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++'))

describe('client-ui-chat StatsLine patch', () => {
  it('touches only the StatsLine stylesheet rules', () => {
    expect(removedLines).toHaveLength(1)
    expect(addedLines).toHaveLength(1)
    expect(removedLines[0]).toContain('const css$2 = ".q2FAPq_root{')
    expect(patch).toContain('client/chat/StatsLine.module.css.mjs')
    expect(removedLines[0]).toContain('q2FAPq_root')
    expect(addedLines[0]).toContain('q2FAPq_root')
  })

  it('drops the content-width clamp that truncated the token-usage tail', () => {
    expect(removedLines[0]).toContain('max-width:var(--dsh-chat-content-width);')
    expect(addedLines[0]).not.toContain('max-width:var(--dsh-chat-content-width);')
  })

  it('wraps long stat rows instead of ellipsizing them', () => {
    expect(removedLines[0]).toContain('white-space:nowrap;text-overflow:ellipsis;')
    expect(addedLines[0]).toContain('white-space:normal;overflow-wrap:anywhere;')
    expect(addedLines[0]).not.toContain('text-overflow:ellipsis;')
  })

  it('keeps the neighboring separator rule untouched', () => {
    expect(addedLines[0]).toContain('.q2FAPq_sep{color:var(--dsw-alias-separator-primary);margin:0 10px}')
  })
})

import { afterAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import Cli, { Input } from '@cordisjs/plugin-cli'
import Yakumo, { Context } from '../../../packages/core/src/index.ts'
import { discoverWorkspaces } from '../../../packages/core/src/workspace.ts'

const temporary = await fs.mkdtemp(resolve(tmpdir(), 'yakumo-prepare-test-'))

afterAll(() => fs.rm(temporary, { recursive: true, force: true }))

async function write(path: string, value: unknown) {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n')
}

/** Run `prepare` and return the root patterns after each run, with the number of installations. */
async function prepare(root: string, runs: number, command = 'prepare') {
  const ctx = new Context()
  await ctx.plugin(Cli, { name: 'yakumo' })
  await ctx.plugin(Yakumo)
  ctx.yakumo.cwd = root
  let installs = 0
  ctx.yakumo.install = async () => { installs++ }
  const results: string[][] = []
  try {
    for (let i = 0; i < runs; i++) {
      await ctx.cli.execute(new Input.String(command))
      results.push(JSON.parse(await fs.readFile(resolve(root, 'package.json'), 'utf8')).workspaces)
    }
  } finally {
    await ctx.fiber.dispose()
  }
  return { results, installs }
}

describe('prepare', () => {
  it('respects patterns that the root excludes', async () => {
    const root = resolve(temporary, 'excluded')
    await write(resolve(root, 'package.json'), { name: 'root', packageManager: 'npm@11.0.0', workspaces: ['repos/*', '!repos/a/packages/*'] })
    await write(resolve(root, 'repos/a/package.json'), { name: 'repo-a', workspaces: ['packages/*'] })
    const { results, installs } = await prepare(root, 2)
    expect(results).toEqual([['repos/*', '!repos/a/packages/*'], ['repos/*', '!repos/a/packages/*']])
    expect(installs).toBe(0)
  })

  it('keeps patterns of deeper groups when cleaning', async () => {
    const root = resolve(temporary, 'nested')
    await write(resolve(root, 'package.json'), { name: 'root', packageManager: 'npm@11.0.0', workspaces: ['repos/*'] })
    await write(resolve(root, 'repos/a/package.json'), { name: 'repo-a', workspaces: ['packages/*'] })
    await write(resolve(root, 'repos/a/packages/b/package.json'), { name: 'b', workspaces: ['sub/*'] })
    await write(resolve(root, 'repos/a/packages/b/sub/c/package.json'), { name: 'c' })
    const { results, installs } = await prepare(root, 3, 'prepare --clean')
    const expected = ['repos/*', 'repos/a/packages/*', 'repos/a/packages/b/sub/*']
    expect(results).toEqual([['repos/*', 'repos/a/packages/*'], expected, expected])
    expect(installs).toBe(2)
  })

  it('applies exclusions regardless of their position', async () => {
    const root = resolve(temporary, 'order')
    await write(resolve(root, 'package.json'), { name: 'root', packageManager: 'npm@11.0.0', workspaces: ['repos/*'] })
    await write(resolve(root, 'repos/a/package.json'), { name: 'repo-a', workspaces: ['packages/*', '!packages/extra'] })
    await write(resolve(root, 'repos/a/packages/foo/package.json'), { name: 'foo' })
    await write(resolve(root, 'repos/a/packages/extra/package.json'), { name: 'extra' })
    const { results } = await prepare(root, 1)
    expect(results[0]).toEqual(['repos/*', 'repos/a/packages/*', '!repos/a/packages/extra'])
    const tree = await discoverWorkspaces(root)
    expect(Object.keys(tree.packages).sort()).toEqual(['', '/repos/a', '/repos/a/packages/foo'])
  })

  it('does not add a nested exclusion of a directory that the root includes', async () => {
    const root = resolve(temporary, 'scoped')
    await write(resolve(root, 'package.json'), { name: 'root', packageManager: 'npm@11.0.0', workspaces: ['repos/*', 'repos/a/packages/extra'] })
    await write(resolve(root, 'repos/a/package.json'), { name: 'repo-a', workspaces: ['packages/*', '!packages/extra'] })
    await write(resolve(root, 'repos/a/packages/foo/package.json'), { name: 'foo' })
    await write(resolve(root, 'repos/a/packages/extra/package.json'), { name: 'extra' })
    const { results } = await prepare(root, 2)
    expect(results.at(-1)).toEqual(['repos/*', 'repos/a/packages/*', 'repos/a/packages/extra'])
    const tree = await discoverWorkspaces(root)
    expect(Object.keys(tree.packages).sort()).toEqual(['', '/repos/a', '/repos/a/packages/extra', '/repos/a/packages/foo'])
  })

  it('does not add a nested exclusion that removes an existing workspace', async () => {
    for (const [name, workspaces, exclusion] of [
      ['glob', ['repos/*', 'repos/a/packages/extra'], '!packages/ex*'],
      ['existing', ['repos/*', 'repos/a/packages/*'], '!packages/extra'],
    ]) {
      const root = resolve(temporary, 'existing-' + name)
      await write(resolve(root, 'package.json'), { name: 'root', packageManager: 'npm@11.0.0', workspaces })
      await write(resolve(root, 'repos/a/package.json'), { name: 'repo-a', workspaces: ['packages/*', exclusion] })
      await write(resolve(root, 'repos/a/packages/foo/package.json'), { name: 'foo' })
      await write(resolve(root, 'repos/a/packages/extra/package.json'), { name: 'extra' })
      await prepare(root, 2)
      const tree = await discoverWorkspaces(root, { npm: true })
      expect(Object.keys(tree.packages).sort()).toEqual(['', '/repos/a', '/repos/a/packages/extra', '/repos/a/packages/foo'])
    }
  })

  it('keeps exclusions that npm cancels canceled after merging', async () => {
    const root = resolve(temporary, 'canceled')
    await write(resolve(root, 'package.json'), { name: 'root', packageManager: 'npm@11.0.0', workspaces: ['packages/*', '!packages/extra', 'packages/extra', 'repos/*'] })
    await write(resolve(root, 'packages/extra/package.json'), { name: 'extra' })
    await write(resolve(root, 'repos/a/package.json'), { name: 'repo-a', workspaces: ['lib/*', '!lib/extra', 'lib/extra'] })
    await write(resolve(root, 'repos/a/lib/extra/package.json'), { name: 'lib-extra' })
    const { results, installs } = await prepare(root, 2)
    expect(installs).toBe(1)
    const tree = await discoverWorkspaces(root, { npm: true })
    expect(Object.keys(tree.packages).sort()).toEqual(['', '/packages/extra', '/repos/a', '/repos/a/lib/extra'])
    expect(results[1]).toEqual(results[0])
  })

  it('adds a nested pattern that a root pattern matches only as a string', async () => {
    const root = resolve(temporary, 'string-match')
    await write(resolve(root, 'package.json'), { name: 'root', packageManager: 'npm@11.0.0', workspaces: ['repos/*', 'repos/a/packages/?'] })
    await write(resolve(root, 'repos/a/package.json'), { name: 'repo-a', workspaces: ['packages/*'] })
    await write(resolve(root, 'repos/a/packages/extra/package.json'), { name: 'extra' })
    await prepare(root, 1)
    const tree = await discoverWorkspaces(root, { npm: true })
    expect(Object.keys(tree.packages).sort()).toEqual(['', '/repos/a', '/repos/a/packages/extra'])
  })

  it('keeps patterns that an ancestor group declares inside a deeper group', async () => {
    const root = resolve(temporary, 'ancestor')
    await write(resolve(root, 'package.json'), { name: 'root', packageManager: 'npm@11.0.0', workspaces: ['repos/*'] })
    await write(resolve(root, 'repos/a/package.json'), { name: 'repo-a', workspaces: ['packages/*', 'packages/b/sub/*'] })
    await write(resolve(root, 'repos/a/packages/b/package.json'), { name: 'b', workspaces: ['own/*'] })
    await write(resolve(root, 'repos/a/packages/b/sub/c/package.json'), { name: 'c' })
    const { results, installs } = await prepare(root, 3, 'prepare --clean')
    const expected = ['repos/*', 'repos/a/packages/*', 'repos/a/packages/b/own/*', 'repos/a/packages/b/sub/*']
    expect(results.at(-1)).toEqual(expected)
    expect(results.at(-2)).toEqual(expected)
    expect(installs).toBe(2)
  })
})

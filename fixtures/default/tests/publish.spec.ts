import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import Cli, { Input } from '@cordisjs/cli'
import Yakumo, { Context } from '../../../packages/core/src/index.ts'

const execute = promisify(execFile)
const temporary = await fs.mkdtemp(resolve(tmpdir(), 'yakumo-publish-test-'))
const summary = resolve(temporary, 'summary.md')

afterAll(() => fs.rm(temporary, { recursive: true, force: true }))

async function write(path: string, value: unknown) {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n')
}

async function version(command: string) {
  return (await execute(command, ['--version'], { cwd: temporary })).stdout.trim()
}

/** A workspace with a public package `foo` and a private package `bar`, neither published. */
async function fixture(name: string, packageManager: string, workspaces?: string[]) {
  const root = resolve(temporary, name)
  const id = randomUUID().slice(0, 8)
  await write(resolve(root, 'package.json'), { name: 'root', private: true, packageManager, workspaces })
  await write(resolve(root, 'packages/foo/package.json'), { name: `yakumo-dry-run-foo-${id}`, version: '1.0.0' })
  await write(resolve(root, 'packages/foo/index.js'), 'module.exports = 1\n')
  await write(resolve(root, 'packages/bar/package.json'), { name: `yakumo-dry-run-bar-${id}`, version: '1.0.0', private: true })
  await write(resolve(root, 'packages/bar/index.js'), 'module.exports = 2\n')
  return root
}

async function patch(path: string, update: (meta: any) => void) {
  const meta = JSON.parse(await fs.readFile(path, 'utf8'))
  update(meta)
  await write(path, meta)
}

/** Run a command and return the publish options passed to listeners and the step summary. */
async function publish(root: string, command: string) {
  const ctx = new Context()
  await ctx.plugin(Cli, { name: 'yakumo' })
  await ctx.plugin(Yakumo)
  ctx.yakumo.cwd = root
  const options: unknown[] = []
  ctx.on('yakumo/publish', (path, meta, publishOptions, next) => {
    options.push(publishOptions)
    return next()
  })
  await fs.rm(summary, { force: true })
  try {
    await ctx.cli.execute(new Input.String(command))
  } finally {
    await ctx.fiber.dispose()
  }
  return { options, summary: await fs.readFile(summary, 'utf8') }
}

const fetch = globalThis.fetch
const writes: string[] = []

beforeEach(() => {
  writes.length = 0
  vi.stubEnv('GITHUB_STEP_SUMMARY', summary)
  vi.stubEnv('npm_config_cache', resolve(temporary, 'npm-cache'))
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (init?.method && init.method !== 'GET') writes.push(String(input))
    return fetch(input, init)
  })
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit(${code})`)
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function expectDryRun(root: string) {
  const manifests = async () => Promise.all(['foo', 'bar'].map(name => fs.readFile(resolve(root, `packages/${name}/package.json`), 'utf8')))
  const before = await manifests()
  const foo = JSON.parse(before[0]).name
  const bar = JSON.parse(before[1]).name

  const all = await publish(root, 'publish --dry-run')
  expect(all.options).toEqual([{ dryRun: true }])
  expect(all.summary).toContain('(Dry Run)')
  expect(all.summary).toContain(`| \`${foo}\` | \`1.0.0\` | :test_tube: Would publish |`)
  expect(all.summary).not.toContain(bar)

  // A private package is reported without prompting or rewriting its manifest.
  const selected = await publish(root, 'publish bar --dry-run')
  expect(selected.summary).toContain(`| \`${bar}\` | \`1.0.0\` | :test_tube: Would publish |`)

  expect(await manifests()).toEqual(before)
  expect(writes).toEqual([])
}

describe('publish --dry-run', () => {
  it('runs npm publish --dry-run', async () => {
    const root = await fixture('npm', `npm@${await version('npm')}`, ['packages/*'])
    await expectDryRun(root)
  }, 120000)

  it('runs pnpm publish --dry-run without Git checks', async () => {
    const root = await fixture('pnpm', `pnpm@${await version('pnpm')}`)
    await write(resolve(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
    // An uncommitted change on a branch other than the default fails the Git checks of pnpm.
    await execute('git', ['init', '-q', '-b', 'feature'], { cwd: root })
    await expectDryRun(root)
  }, 120000)

  it('runs yarn npm publish --dry-run for private workspaces as public', async () => {
    // The version of this repository, which is Yarn 4.10 or later.
    const yarn = (await execute('yarn', ['--version'])).stdout.trim()
    const root = await fixture('yarn', `yarn@${yarn}`, ['packages/*'])
    await write(resolve(root, '.yarnrc.yml'), 'nodeLinker: node-modules\n')
    vi.stubEnv('YARN_GLOBAL_FOLDER', resolve(temporary, 'yarn-global'))
    vi.stubEnv('YARN_ENABLE_IMMUTABLE_INSTALLS', 'false')
    await execute('yarn', ['install'], { cwd: root, env: process.env })
    await expectDryRun(root)

    // The dry run of a private workspace runs the checks and lifecycle scripts of a publish.
    await patch(resolve(root, 'packages/bar/package.json'), meta => meta.scripts = { prepublish: 'exit 1' })
    await expect(publish(root, 'publish bar --dry-run')).rejects.toThrow('process.exit(1)')
    expect(JSON.parse(await fs.readFile(resolve(root, 'packages/bar/package.json'), 'utf8')).private).toBe(true)
  }, 120000)

  it('restores a private manifest when a Yarn dry run is interrupted', async () => {
    const yarn = (await execute('yarn', ['--version'])).stdout.trim()
    const root = await fixture('yarn-interrupt', `yarn@${yarn}`, ['packages/*'])
    await write(resolve(root, '.yarnrc.yml'), 'nodeLinker: node-modules\n')
    const marker = resolve(root, 'prepublish-started')
    const env = { ...process.env, YARN_GLOBAL_FOLDER: resolve(temporary, 'yarn-global'), YARN_ENABLE_IMMUTABLE_INSTALLS: 'false', MARKER: marker }
    await execute('yarn', ['install'], { cwd: root, env })
    const manifest = resolve(root, 'packages/bar/package.json')
    // The script signals that it has started, then outlasts the test.
    await patch(manifest, meta => meta.scripts = { prepublish: `node -e "require('fs').writeFileSync(process.env.MARKER, '');setTimeout(() => {}, 60000)"` })
    const before = await fs.readFile(manifest, 'utf8')

    const script = resolve(root, 'publish.mjs')
    await write(script, [
      `import Cli, { Input } from ${JSON.stringify(import.meta.resolve('@cordisjs/cli'))}`,
      `import Yakumo, { Context } from ${JSON.stringify(new URL('../../../packages/core/src/index.ts', import.meta.url).href)}`,
      'const ctx = new Context()',
      `await ctx.plugin(Cli, { name: 'yakumo' })`,
      'await ctx.plugin(Yakumo)',
      `ctx.yakumo.cwd = ${JSON.stringify(root)}`,
      `await ctx.cli.execute(new Input.String('publish bar --dry-run'))`,
    ].join('\n'))
    // A separate process group receives SIGINT as a terminal does on Ctrl+C.
    const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd: process.cwd(), env, detached: true, stdio: 'ignore' })
    const exited = new Promise<NodeJS.Signals | number | null>(resolve => child.on('exit', (code, signal) => resolve(signal ?? code)))
    while (!await fs.stat(marker).catch(() => null)) await sleep(100)
    expect(JSON.parse(await fs.readFile(manifest, 'utf8')).private).toBeUndefined()
    process.kill(-child.pid!, 'SIGINT')
    expect(await exited).toBe('SIGINT')
    expect(await fs.readFile(manifest, 'utf8')).toBe(before)
  }, 120000)

  it('requires Yarn 4.10 or later', async () => {
    const root = await fixture('yarn-4.9', 'yarn@4.9.0', ['packages/*'])
    await expect(publish(root, 'publish --dry-run')).rejects.toThrow('requires Yarn 4.10 or later')
  })
})

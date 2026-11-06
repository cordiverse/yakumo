import { afterAll, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createRequire, isBuiltin } from 'node:module'
import { build } from 'esbuild'
import Cli, { Input } from '@cordisjs/plugin-cli'
import Yakumo, { Context } from '../../../packages/core/src/index.ts'
import { parseSyml, stringifySyml } from '@yarnpkg/parsers'
import { syncLockfiles, seedYarn } from '../../../packages/core/src/lock.ts'
import { discoverWorkspaces } from '../../../packages/core/src/workspace.ts'

const execute = promisify(execFile)
const temporary = await fs.mkdtemp(resolve(tmpdir(), 'yakumo-lock-test-'))
const host = resolve(temporary, 'host')
const require = createRequire(import.meta.url)
// Keep the package cache and metadata of fixture installations out of the user's global Yarn folder.
const globalFolder = resolve(temporary, 'yarn-global')
const env = { ...process.env, YARN_GLOBAL_FOLDER: globalFolder, YARN_ENABLE_TELEMETRY: '0', YARN_ENABLE_IMMUTABLE_INSTALLS: 'false', CI: '' }
delete env.YARN_PLUGINS
const yarn = ['yarn']
const { stdout: versionOutput } = await execute(yarn[0], [...yarn.slice(1), '--version'], { env })
const version = versionOutput.trim()
const manager = { name: 'yarn', version }
const options = { command: yarn, env, check: false }

// Exercise the published ESM entry from postinstall without depending on a previous build.
await write(resolve(host, 'package.json'), { name: 'yakumo', type: 'module', exports: { './lock': './lib/lock.js' } })
await build({
  entryPoints: [fileURLToPath(new URL('../../../packages/core/src/lock.ts', import.meta.url))],
  outfile: resolve(host, 'lib/lock.js'), bundle: true, platform: 'node', format: 'esm',
  plugins: [{
    name: 'host-dependencies',
    setup(builder) {
      builder.onResolve({ filter: /^[^./]/ }, args => ({ path: isBuiltin(args.path) ? args.path : require.resolve(args.path), external: true }))
    },
  }],
})

await write(resolve(host, 'postinstall.mjs'), `
import { appendFileSync } from 'node:fs';
import { syncLockfiles } from './lib/lock.js';
const results = await syncLockfiles(process.cwd());
appendFileSync('postinstall-runs.jsonl', JSON.stringify(results) + '\\n');
`)

async function write(path: string, value: unknown) {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n')
}

async function run(root: string, args: string[], extra = {}) {
  return execute(yarn[0], [...yarn.slice(1), ...args], { cwd: root, env: { ...env, ...extra }, maxBuffer: 4 * 1024 * 1024 }).catch(error => {
    error.message += '\n' + error.stdout + error.stderr
    throw error
  })
}

async function fixture(name: string, external = false) {
  const root = resolve(temporary, name)
  await write(resolve(root, 'package.json'), { name: 'root', private: true, packageManager: `yarn@${version}`, workspaces: ['repos/*'] })
  await write(resolve(root, '.yarnrc.yml'), 'nodeLinker: node-modules\n')
  await write(resolve(root, 'yarn.lock'), stringifySyml({
    __metadata: { version: 9 },
    'semver@npm:^7.7.4': { version: '7.7.4', resolution: 'semver@npm:7.7.4', bin: { semver: 'bin/semver.js' }, languageName: 'node', linkType: 'hard' },
  }))
  await write(resolve(root, 'repos/a/package.json'), { name: 'repo-a', private: true, packageManager: `yarn@${version}`, workspaces: ['packages/*', 'external/*'] })
  await write(resolve(root, 'repos/a/.yarnrc.yml'), 'nodeLinker: node-modules\n')
  await write(resolve(root, 'repos/a/.gitignore'), '/external\n')
  await execute('git', ['init', '-q'], { cwd: resolve(root, 'repos/a') })
  await write(resolve(root, 'repos/a/packages/consumer/package.json'), {
    name: 'consumer', version: '1.0.0',
    dependencies: { semver: '^7.7.4', peer: 'workspace:*' },
  })
  await write(resolve(root, 'repos/a/packages/peer/package.json'), { name: 'peer', version: '1.0.0', peerDependencies: { semver: '^7.7.4' } })
  if (external) await write(resolve(root, 'repos/b/package.json'), { name: 'semver', version: '7.7.4' })
  await run(root, ['install', '--mode=skip-build'])
  return root
}

afterAll(() => fs.rm(temporary, { recursive: true, force: true }))

describe('workspace discovery', () => {
  it('expands nested groups only when recursive, scoping negations to their group like Yarn', async () => {
    const root = resolve(temporary, 'discovery')
    await write(resolve(root, 'package.json'), { workspaces: ['repos/*'] })
    await write(resolve(root, 'repos/a/package.json'), { workspaces: ['packages/*', '!packages/excluded'] })
    await write(resolve(root, 'repos/a/packages/included/package.json'), { name: 'included' })
    await write(resolve(root, 'repos/a/packages/excluded/package.json'), { name: 'excluded' })
    const flat = await discoverWorkspaces(root)
    expect(Object.keys(flat.packages)).toEqual(['', '/repos/a'])
    expect(Object.keys(flat.groups)).toEqual(['', '/repos/a'])
    const tree = await discoverWorkspaces(root, { recursive: true })
    expect(Object.keys(tree.packages)).toEqual(['', '/repos/a', '/repos/a/packages/included'])

    // A nested negation does not hide a directory that an outer group lists explicitly.
    await write(resolve(root, 'package.json'), { workspaces: ['repos/*', 'repos/a/packages/excluded'] })
    const outer = await discoverWorkspaces(root, { recursive: true })
    expect(Object.keys(outer.packages).sort()).toEqual(['', '/repos/a', '/repos/a/packages/excluded', '/repos/a/packages/included'])
  })
})

describe('Yarn lockfiles', () => {
  it('prefers root resolutions even when descriptors were grouped differently in an old child lock', () => {
    const record = version => ({ version, resolution: `semver@npm:${version}` })
    const root = stringifySyml({ __metadata: { version: 8 }, 'semver@npm:^7': record('7.7.4'), 'peer@workspace:repos/a': { resolution: 'peer@workspace:repos/a' } })
    const old = stringifySyml({ __metadata: { version: 8 }, 'semver@npm:^7, semver@npm:*': record('7.7.3') })
    const result = parseSyml(seedYarn(root, old))
    expect(result['semver@npm:^7'].version).toBe('7.7.4')
    expect(result['semver@npm:*'].version).toBe('7.7.3')
    expect(result['peer@workspace:repos/a']).toBeUndefined()
  })

  it('exports repository groups, checks drift without writes, and supports standalone immutable installs', async () => {
    const root = await fixture('normal')
    const before = await fs.readFile(resolve(root, 'yarn.lock'), 'utf8')
    const first = await syncLockfiles(root, manager, options)
    expect(first).toEqual([{ path: resolve(root, 'repos/a/yarn.lock'), changed: true }])
    const lock = await fs.readFile(first[0].path, 'utf8')
    expect(lock).toContain('consumer@workspace:packages/consumer')
    expect(lock).toContain('peer@workspace:packages/peer')
    expect(lock).not.toContain('workspace:repos/')
    expect(await fs.stat(resolve(root, 'repos/a/node_modules')).catch(() => null)).toBeNull()
    expect(await fs.readFile(resolve(root, 'yarn.lock'), 'utf8')).toBe(before)
    expect((await syncLockfiles(root, manager, { ...options, check: true }))[0].changed).toBe(false)

    const standalone = resolve(temporary, 'standalone')
    await fs.cp(resolve(root, 'repos/a'), standalone, { recursive: true, filter: path => !path.includes('node_modules') && !path.includes('/.git') })
    await run(standalone, ['install', '--immutable', '--mode=skip-build'])
    expect(await fs.readFile(resolve(standalone, 'yarn.lock'), 'utf8')).toBe(lock)

    await fs.writeFile(first[0].path, '# drift\n' + lock)
    await expect(syncLockfiles(root, manager, { ...options, check: true })).rejects.toThrow('Outdated lockfiles')
    expect(await fs.readFile(first[0].path, 'utf8')).toBe('# drift\n' + lock)
  }, 60000)

  it('uses old child registry records when root installation links an outside workspace', async () => {
    const root = await fixture('external')
    const source = await fixture('registry-seed')
    await syncLockfiles(source, manager, options)
    await fs.copyFile(resolve(source, 'repos/a/yarn.lock'), resolve(root, 'repos/a/yarn.lock'))
    await syncLockfiles(root, manager, options)
    const lock = await fs.readFile(resolve(root, 'repos/a/yarn.lock'), 'utf8')
    expect(lock).toContain('semver@npm:')
    expect(lock).not.toContain('workspace:repos/b')
    await run(resolve(root, 'repos/a'), ['install', '--immutable', '--mode=skip-build'])
  }, 60000)

  it('honors a repository Yarn version without rewriting its manifest or the root lock', async () => {
    const root = await fixture('mixed-yarn-versions')
    const manifestPath = resolve(root, 'repos/a/package.json')
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
    manifest.packageManager = 'yarn@4.7.0'
    await write(manifestPath, manifest)
    const rootLock = await fs.readFile(resolve(root, 'yarn.lock'), 'utf8')
    await syncLockfiles(root, manager, options)
    const lock = await fs.readFile(resolve(root, 'repos/a/yarn.lock'), 'utf8')
    expect(Number(parseSyml(lock).__metadata.version)).toBe(8)
    await execute('corepack', ['yarn@4.7.0', 'install', '--immutable', '--mode=skip-build'], { cwd: resolve(root, 'repos/a'), env })
    expect(await fs.readFile(resolve(root, 'repos/a/yarn.lock'), 'utf8')).toBe(lock)
    expect((await syncLockfiles(root, manager, { ...options, check: true }))[0].changed).toBe(false)
    expect(await fs.readFile(resolve(root, 'yarn.lock'), 'utf8')).toBe(rootLock)
    expect(JSON.parse(await fs.readFile(manifestPath, 'utf8'))).toEqual(manifest)
  }, 60000)

  it('excludes ignored nested clones and skips unsupported repositories with a warning', async () => {
    const root = await fixture('boundaries')
    await write(resolve(root, 'repos/a/external/ignored/package.json'), { name: 'ignored', version: '1.0.0' })
    await run(root, ['install', '--mode=skip-build'])
    await syncLockfiles(root, manager, options)
    const lockA = resolve(root, 'repos/a/yarn.lock')
    const before = await fs.readFile(lockA, 'utf8')
    expect(before).not.toContain('ignored@workspace:')

    await write(resolve(root, 'repos/b/package.json'), { name: 'repo-b', dependencies: { consumer: 'workspace:*' } })
    await execute('git', ['init', '-q'], { cwd: resolve(root, 'repos/b') })
    const lockB = resolve(root, 'repos/b/yarn.lock')
    await fs.writeFile(lockB, '# stale\n')
    await fs.writeFile(lockA, '# drift\n' + before)
    const warnings: string[] = []
    const results = await syncLockfiles(root, manager, { ...options, onWarning: message => warnings.push(message) })
    expect(results).toEqual([
      { path: lockA, changed: true },
      { path: lockB, changed: false, skipped: expect.stringContaining('crosses a repository boundary') },
    ])
    expect(warnings).toEqual([expect.stringMatching(/^Skipping repos\/b: .*existing yarn\.lock left unchanged$/)])
    expect(await fs.readFile(lockA, 'utf8')).toBe(before)
    expect(await fs.readFile(lockB, 'utf8')).toBe('# stale\n')

    // Check mode reports skipped repositories without failing, unless strict.
    const quiet = { ...options, onWarning() {} }
    expect((await syncLockfiles(root, manager, { ...quiet, check: true })).map(item => item.changed)).toEqual([false, false])
    await expect(syncLockfiles(root, manager, { ...quiet, check: true, strict: true })).rejects.toThrow('crosses a repository boundary')
  }, 60000)

  it('aborts without writing any lockfile when a supported repository fails to resolve', async () => {
    const root = await fixture('resolution-failure')
    await syncLockfiles(root, manager, options)
    const lockA = resolve(root, 'repos/a/yarn.lock')
    const before = await fs.readFile(lockA, 'utf8')
    await fs.writeFile(lockA, '# drift\n' + before)
    await write(resolve(root, 'repos/b/package.json'), { name: 'repo-b', dependencies: { 'yakumo-test-missing-package-7f3a9c': '^1.0.0' } })
    await execute('git', ['init', '-q'], { cwd: resolve(root, 'repos/b') })
    await expect(syncLockfiles(root, manager, options)).rejects.toThrow('Cannot resolve standalone lockfile')
    expect(await fs.readFile(lockA, 'utf8')).toBe('# drift\n' + before)
    expect(await fs.stat(resolve(root, 'repos/b/yarn.lock')).catch(() => null)).toBeNull()
  }, 60000)

  it('synchronizes from root postinstall and exposes cached or skipped lifecycle runs', async () => {
    const root = await fixture('postinstall')
    const manifest = JSON.parse(await fs.readFile(resolve(root, 'package.json'), 'utf8'))
    manifest.scripts = { postinstall: `node ${JSON.stringify(resolve(host, 'postinstall.mjs'))}` }
    await write(resolve(root, 'package.json'), manifest)
    await run(root, ['install'])
    const target = resolve(root, 'repos/a/yarn.lock')
    const lock = await fs.readFile(target, 'utf8')
    expect(lock).toContain('consumer@workspace:packages/consumer')
    const countRuns = async () => (await fs.readFile(resolve(root, 'postinstall-runs.jsonl'), 'utf8')).trim().split('\n').length
    expect(await countRuns()).toBe(1)
    await fs.writeFile(target, '# drift\n' + lock)
    await run(root, ['install'])
    expect(await countRuns()).toBe(1)
    expect(await fs.readFile(target, 'utf8')).toBe('# drift\n' + lock)
    await run(root, ['install', '--mode=skip-build'])
    expect(await countRuns()).toBe(1)
    expect(await fs.readFile(target, 'utf8')).toBe('# drift\n' + lock)
    await expect(syncLockfiles(root, manager, { ...options, check: true })).rejects.toThrow('Outdated lockfiles')
    await expect(run(root, ['run', 'postinstall'], { CI: 'true' })).rejects.toThrow('Outdated lockfiles')
    expect(await fs.readFile(target, 'utf8')).toBe('# drift\n' + lock)
    await run(root, ['add', '--dev', 'semver@^7.7.4'])
    expect(await countRuns()).toBe(2)
    expect(await fs.readFile(target, 'utf8')).toBe(lock)

    // Nested locks also affect mutation commands: this add belongs to the child project.
    const rootLock = await fs.readFile(resolve(root, 'yarn.lock'), 'utf8')
    await run(root, ['workspace', 'consumer', 'add', 'peer@workspace:^'])
    expect(await countRuns()).toBe(2)
    expect(await fs.readFile(resolve(root, 'yarn.lock'), 'utf8')).toBe(rootLock)
    await run(root, ['install'])
    await run(root, ['run', 'postinstall'])
    const afterAdd = await fs.readFile(target, 'utf8')
    expect(afterAdd).not.toContain('# drift')
    expect(parseSyml(afterAdd)['consumer@workspace:packages/consumer'].dependencies.peer).toBe('workspace:^')
  }, 60000)

  it('routes postinstall and lock commands through the CLI', async () => {
    vi.stubEnv('CI', '')
    // The CLI spawns Yarn with process.env rather than the test environment.
    vi.stubEnv('YARN_GLOBAL_FOLDER', globalFolder)
    const root = await fixture('commands')
    const ctx = new Context()
    await ctx.plugin(Cli, { name: 'yakumo' })
    await ctx.plugin(Yakumo)
    ctx.yakumo.cwd = root
    try {
      await ctx.cli.execute(new Input.String('postinstall'))
      const target = resolve(root, 'repos/a/yarn.lock')
      const before = await fs.readFile(target, 'utf8')
      await fs.writeFile(target, '# drift\n' + before)
      await expect(ctx.cli.execute(new Input.String('lock --immutable'))).rejects.toThrow('Outdated lockfiles')
      await ctx.cli.execute(new Input.String('lock repos/a'))
      expect(await fs.readFile(target, 'utf8')).toBe(before)
    } finally {
      await ctx.fiber.dispose()
      vi.unstubAllEnvs()
    }
  }, 60000)
})

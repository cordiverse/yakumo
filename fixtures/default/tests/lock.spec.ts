import { afterAll, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createRequire, isBuiltin } from 'node:module'
import { build } from 'esbuild'
import Cli, { Input } from '@cordisjs/cli'
import Yakumo, { Context } from '../../../packages/core/src/index.ts'
import { parseSyml, stringifySyml } from '@yarnpkg/parsers'
import { parse as parseYaml, parseAllDocuments } from 'yaml'
import { syncLockfiles, seedNpm, seedPnpm, seedYarn } from '../../../packages/core/src/lock.ts'
import { detectManager, discoverWorkspaces, writePnpmPackages } from '../../../packages/core/src/workspace.ts'

const execute = promisify(execFile)
const temporary = await fs.mkdtemp(resolve(tmpdir(), 'yakumo-lock-test-'))
const host = resolve(temporary, 'host')
const require = createRequire(import.meta.url)
// Keep the package cache and metadata of fixture installations out of the user's global Yarn folder.
const globalFolder = resolve(temporary, 'yarn-global')
const env: NodeJS.ProcessEnv = { ...process.env, YARN_GLOBAL_FOLDER: globalFolder, YARN_ENABLE_TELEMETRY: '0', YARN_ENABLE_IMMUTABLE_INSTALLS: 'false', CI: '' }
// Likewise for npm and pnpm, which also read their settings from these variables.
for (const prefix of ['npm_config_', 'pnpm_config_']) {
  env[prefix + 'cache'] = resolve(temporary, 'npm-cache')
  env[prefix + 'cache_dir'] = resolve(temporary, 'pnpm-cache')
  env[prefix + 'store_dir'] = resolve(temporary, 'pnpm-store')
  env[prefix + 'state_dir'] = resolve(temporary, 'pnpm-state')
}
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

  it('applies exclusions in the order of npm and regardless of order for other managers', async () => {
    const root = resolve(temporary, 'discovery-order')
    await write(resolve(root, 'package.json'), { workspaces: ['packages/*', '!packages/extra', 'packages/extra', '!packages/skip'] })
    await write(resolve(root, 'packages/extra/package.json'), { name: 'extra' })
    await write(resolve(root, 'packages/skip/package.json'), { name: 'skip' })
    await write(resolve(root, 'packages/foo/package.json'), { name: 'foo' })
    expect(Object.keys((await discoverWorkspaces(root, { npm: true })).packages)).toEqual(['', '/packages/extra', '/packages/foo'])
    expect(Object.keys((await discoverWorkspaces(root)).packages)).toEqual(['', '/packages/foo'])

    // npm strips `./` and treats an even number of `!` as an inclusion.
    await write(resolve(root, 'package.json'), { workspaces: ['packages/*', '!packages/extra', './packages/extra', '!!!packages/skip'] })
    expect(Object.keys((await discoverWorkspaces(root, { npm: true })).packages)).toEqual(['', '/packages/extra', '/packages/foo'])
    await write(resolve(root, 'package.json'), { workspaces: ['!!packages/*'] })
    expect(Object.keys((await discoverWorkspaces(root, { npm: true })).packages)).toEqual(['', '/packages/extra', '/packages/foo', '/packages/skip'])
  })

  it('reads the package manager from packageManager only', async () => {
    const root = resolve(temporary, 'detection')
    const detect = async (meta: object) => {
      await write(resolve(root, 'package.json'), { name: 'root', ...meta })
      return detectManager(root)
    }
    await write(resolve(root, 'pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\n')
    expect(await detect({ packageManager: 'pnpm@12.18.0+sha512.abc' })).toEqual({ name: 'pnpm', version: '12.18.0' })
    await expect(detect({ devEngines: { packageManager: { name: 'pnpm' } } })).rejects.toThrow('missing packageManager')
    await expect(detect({ packageManager: 'bun@1.3.0' })).rejects.toThrow('unsupported package manager bun')
    await expect(detect({ packageManager: 'pnpm@^12' })).rejects.toThrow('invalid packageManager')
    await write(resolve(root, 'package.json'), { name: 'root' })
    expect(await detectManager(root, { name: 'npm', version: '11.0.0' })).toEqual({ name: 'npm', version: '11.0.0' })
  })

  it('reads pnpm groups from pnpm-workspace.yaml and rewrites only their patterns', async () => {
    const root = resolve(temporary, 'discovery-pnpm')
    await write(resolve(root, 'package.json'), { name: 'root', workspaces: ['ignored/*'] })
    await write(resolve(root, 'pnpm-workspace.yaml'), '# root\npackages:\n  - repos/*\ncatalog:\n  ms: ^2.1.0 # pinned\n')
    await write(resolve(root, 'repos/a/package.json'), { name: 'repo-a' })
    await write(resolve(root, 'repos/a/pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
    await write(resolve(root, 'repos/a/packages/foo/package.json'), { name: 'foo' })
    await write(resolve(root, 'ignored/bar/package.json'), { name: 'bar' })
    const tree = await discoverWorkspaces(root, { pnpm: true })
    expect(Object.keys(tree.packages)).toEqual(['', '/repos/a'])
    expect(tree.groups).toEqual({ '': { path: '', patterns: ['repos/*'] }, '/repos/a': { path: '/repos/a', patterns: ['packages/*'] } })

    await writePnpmPackages(root, ['repos/*', 'repos/a/packages/*'])
    const content = await fs.readFile(resolve(root, 'pnpm-workspace.yaml'), 'utf8')
    expect(content).toContain('# root')
    expect(content).toContain('# pinned')
    expect(parseYaml(content)).toEqual({ packages: ['repos/*', 'repos/a/packages/*'], catalog: { ms: '^2.1.0' } })
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

async function exec(command: string[], args: string[], cwd: string) {
  return execute(command[0], [...command.slice(1), ...args], { cwd, env, maxBuffer: 4 * 1024 * 1024 }).catch(error => {
    error.message += '\n' + error.stdout + error.stderr
    throw error
  })
}

async function patch(path: string, update: (meta: any) => void) {
  const meta = JSON.parse(await fs.readFile(path, 'utf8'))
  update(meta)
  await write(path, meta)
}

/** Copy a repository as a standalone checkout. */
async function checkout(source: string, name: string) {
  const target = resolve(temporary, name)
  await fs.cp(source, target, { recursive: true, filter: path => !/\/(node_modules|\.git|external)(\/|$)/.test(path.slice(source.length)) })
  return target
}

/**
 * Lay out a repository that the outer root installs together with one of its own packages.
 * The root lockfile keeps `semver@7.7.4` for `consumer`, which a fresh resolution of `^7.7.0`
 * would not select. `ignored` is a nested clone ignored by the repository.
 */
async function layout(root: string, internal: string) {
  await write(resolve(root, 'repos/a/.gitignore'), '/external\n')
  await execute('git', ['init', '-q'], { cwd: resolve(root, 'repos/a') })
  await write(resolve(root, 'repos/a/packages/consumer/package.json'), {
    name: 'consumer', version: '1.0.0',
    dependencies: { semver: '~7.7.0', peer: internal },
  })
  await write(resolve(root, 'repos/a/packages/peer/package.json'), { name: 'peer', version: '1.0.0', dependencies: { ms: '^2.1.0' } })
  await write(resolve(root, 'repos/a/external/ignored/package.json'), { name: 'ignored', version: '1.0.0', dependencies: { 'is-number': '^7.0.0' } })
}

describe('npm lockfiles', async () => {
  const npm = ['npm']
  const version = (await exec(npm, ['--version'], temporary)).stdout.trim()
  const manager = { name: 'npm', version }
  const options = { command: npm, env, check: false }
  const install = (cwd: string, ...args: string[]) => exec(npm, ['install', '--no-audit', '--no-fund', ...args], cwd)

  async function fixture(name: string) {
    const root = resolve(temporary, name)
    await write(resolve(root, 'package.json'), { name: 'root', private: true, packageManager: `npm@${version}`, workspaces: ['repos/*', 'repos/a/packages/*', 'repos/a/external/*'] })
    await write(resolve(root, 'repos/a/package.json'), { name: 'repo-a', private: true, workspaces: ['packages/*', 'external/*'] })
    await layout(root, '^1.0.0')
    await install(root, '--package-lock-only')
    await patch(resolve(root, 'repos/a/packages/consumer/package.json'), meta => meta.dependencies.semver = '^7.7.0')
    await install(root, '--package-lock-only')
    expect(JSON.parse(await fs.readFile(resolve(root, 'package-lock.json'), 'utf8')).packages['node_modules/semver'].version).toBe('7.7.4')
    return root
  }

  it('prefers root placements and takes only packages unknown to the root from an old child lock', () => {
    const record = (version: string) => ({ version, resolved: `https://registry.npmjs.org/semver/-/semver-${version}.tgz` })
    const root = JSON.stringify({ lockfileVersion: 3, packages: {
      '': { name: 'root' },
      'node_modules/semver': record('7.7.4'),
      'node_modules/consumer': { resolved: 'repos/a/packages/consumer', link: true },
      'node_modules/outside': { resolved: 'repos/b', link: true },
      'node_modules/local': { resolved: '../local', version: '1.0.0' },
      'repos/a/packages/consumer': { version: '1.0.0' },
      'repos/a/packages/consumer/node_modules/ms': record('2.1.3'),
      'repos/b': { version: '1.0.0' },
    } })
    const old = JSON.stringify({ lockfileVersion: 3, packages: {
      'node_modules/outside': record('1.0.0'),
      'packages/consumer/node_modules/semver': record('7.7.3'),
    } })
    expect(JSON.parse(seedNpm(root, old, 'repos/a', ['', 'packages/consumer'])).packages).toEqual({
      'node_modules/semver': record('7.7.4'),
      'node_modules/consumer': { resolved: 'packages/consumer', link: true },
      'node_modules/outside': record('1.0.0'),
      'packages/consumer': { version: '1.0.0' },
      'packages/consumer/node_modules/ms': record('2.1.3'),
    })
  })

  it('maps root placements into the repository and supports standalone clean installs', async () => {
    const root = await fixture('npm')
    const rootLock = await fs.readFile(resolve(root, 'package-lock.json'), 'utf8')
    const [result] = await syncLockfiles(root, manager, options)
    expect(result).toEqual({ path: resolve(root, 'repos/a/package-lock.json'), changed: true })
    const content = await fs.readFile(result.path, 'utf8')
    const { packages } = JSON.parse(content)
    expect(packages['node_modules/semver'].version).toBe('7.7.4')
    expect(packages['node_modules/peer']).toEqual({ resolved: 'packages/peer', link: true })
    expect(Object.keys(packages).filter(key => /ignored|is-number|repos\//.test(key))).toEqual([])
    expect(await fs.readFile(resolve(root, 'package-lock.json'), 'utf8')).toBe(rootLock)
    expect((await syncLockfiles(root, manager, { ...options, check: true }))[0].changed).toBe(false)

    const standalone = await checkout(resolve(root, 'repos/a'), 'npm-standalone')
    await exec(npm, ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], standalone)
    await install(standalone, '--package-lock-only', '--ignore-scripts')
    expect(await fs.readFile(resolve(standalone, 'package-lock.json'), 'utf8')).toBe(content)
  }, 120000)

  it('synchronizes from root postinstall', async () => {
    const root = await fixture('npm-postinstall')
    await patch(resolve(root, 'package.json'), meta => meta.scripts = { postinstall: `node ${JSON.stringify(resolve(host, 'postinstall.mjs'))}` })
    await install(root)
    const content = await fs.readFile(resolve(root, 'repos/a/package-lock.json'), 'utf8')
    expect(JSON.parse(content).packages['node_modules/semver'].version).toBe('7.7.4')
  }, 120000)
})

describe('pnpm lockfiles', async () => {
  // Corepack selects pnpm outside of this Yarn project; fixtures pin the same version.
  const version = (await exec(['corepack', 'pnpm'], ['--version'], temporary)).stdout.trim()
  const pnpm = ['corepack', `pnpm@${version}`]
  const manager = { name: 'pnpm', version }
  const options = { command: pnpm, env, check: false }
  const install = (cwd: string, ...args: string[]) => exec(pnpm, ['install', '--no-frozen-lockfile', ...args], cwd)
  const read = async (path: string) => parseAllDocuments(await fs.readFile(path, 'utf8')).map(document => document.toJS()).at(-1)

  async function fixture(name: string) {
    const root = resolve(temporary, name)
    const packageManager = `pnpm@${version}`
    await write(resolve(root, 'package.json'), { name: 'root', private: true, packageManager })
    await write(resolve(root, 'pnpm-workspace.yaml'), 'packages:\n  - repos/*\n  - repos/a/packages/*\n  - repos/a/external/*\n')
    await write(resolve(root, 'repos/a/package.json'), { name: 'repo-a', private: true, packageManager })
    await write(resolve(root, 'repos/a/pnpm-workspace.yaml'), 'packages:\n  - packages/*\n  - external/*\n')
    await layout(root, 'workspace:*')
    await install(root, '--lockfile-only')
    await patch(resolve(root, 'repos/a/packages/consumer/package.json'), meta => meta.dependencies.semver = '^7.7.0')
    await install(root, '--lockfile-only')
    const lock = await read(resolve(root, 'pnpm-lock.yaml'))
    expect(lock.importers['repos/a/packages/consumer'].dependencies.semver.version).toBe('7.7.4')
    return root
  }

  it('prefers root importers, replaces dependencies on unstaged directories, and prunes unreachable packages', () => {
    const resolution = (name: string) => ({ resolution: { integrity: `sha512-${name}` } })
    const root = [
      'lockfileVersion: \'9.0\'',
      'importers:',
      '  .: { devDependencies: { is-number: { specifier: ^7.0.0, version: 7.0.0 } } }',
      '  repos/a: {}',
      '  repos/a/packages/consumer:',
      '    dependencies:',
      '      semver: { specifier: ^7.7.0, version: 7.7.4 }',
      '      outside: { specifier: ^1.0.0, version: link:../../../b }',
      '      peer: { specifier: workspace:*, version: link:../peer }',
      '      ms: { specifier: ^2.1.0, version: link:../../external/ms }',
      '      injected: { specifier: workspace:*, version: file:repos/a/packages/injected }',
      '  repos/b: {}',
      'packages:',
      '  semver@7.7.4: { resolution: { integrity: sha512-semver@7.7.4 } }',
      '  is-number@7.0.0: { resolution: { integrity: sha512-is-number@7.0.0 } }',
      'snapshots:',
      '  semver@7.7.4: {}',
      '  is-number@7.0.0: {}',
    ].join('\n')
    const old = [
      'lockfileVersion: \'9.0\'',
      'settings: { autoInstallPeers: false }',
      'importers:',
      '  packages/consumer:',
      '    dependencies:',
      '      semver: { specifier: ^7.7.0, version: 7.7.3 }',
      '      outside: { specifier: ^1.0.0, version: 1.0.0(semver@7.7.3) }',
      '      ms: { specifier: ^2.1.0, version: link:../../external/ms }',
      '  packages/peer:',
      '    dependencies:',
      '      consumer: { specifier: workspace:*, version: link:../consumer }',
      '      ignored: { specifier: workspace:*, version: link:../../external/ignored }',
      'packages:',
      '  semver@7.7.3: { resolution: { integrity: sha512-semver@7.7.3 } }',
      '  outside@1.0.0: { resolution: { integrity: sha512-outside@1.0.0 } }',
      'snapshots:',
      '  semver@7.7.3: {}',
      '  outside@1.0.0(semver@7.7.3): { dependencies: { semver: 7.7.3 } }',
    ].join('\n')
    expect(parseYaml(seedPnpm(root, old, 'repos/a', ['', 'packages/consumer', 'packages/peer']))).toEqual({
      lockfileVersion: '9.0',
      settings: { autoInstallPeers: false },
      importers: {
        '.': {},
        'packages/consumer': {
          dependencies: {
            semver: { specifier: '^7.7.0', version: '7.7.4' },
            outside: { specifier: '^1.0.0', version: '1.0.0(semver@7.7.3)' },
            peer: { specifier: 'workspace:*', version: 'link:../peer' },
          },
        },
        'packages/peer': {
          dependencies: { consumer: { specifier: 'workspace:*', version: 'link:../consumer' } },
        },
      },
      packages: { 'semver@7.7.4': resolution('semver@7.7.4'), 'outside@1.0.0': resolution('outside@1.0.0'), 'semver@7.7.3': resolution('semver@7.7.3') },
      snapshots: { 'semver@7.7.4': {}, 'outside@1.0.0(semver@7.7.3)': { dependencies: { semver: '7.7.3' } }, 'semver@7.7.3': {} },
    })
  })

  it('maps root importers into the repository and supports standalone frozen installs', async () => {
    const root = await fixture('pnpm')
    const rootLock = await fs.readFile(resolve(root, 'pnpm-lock.yaml'), 'utf8')
    const [result] = await syncLockfiles(root, manager, options)
    expect(result).toEqual({ path: resolve(root, 'repos/a/pnpm-lock.yaml'), changed: true })
    const content = await fs.readFile(result.path, 'utf8')
    const lock = await read(result.path)
    expect(Object.keys(lock.importers).sort()).toEqual(['.', 'packages/consumer', 'packages/peer'])
    expect(lock.importers['packages/consumer'].dependencies).toMatchObject({
      semver: { version: '7.7.4' },
      peer: { version: 'link:../peer' },
    })
    expect(content).not.toContain('is-number')
    expect(await fs.readFile(resolve(root, 'pnpm-lock.yaml'), 'utf8')).toBe(rootLock)
    expect((await syncLockfiles(root, manager, { ...options, check: true }))[0].changed).toBe(false)

    const standalone = await checkout(resolve(root, 'repos/a'), 'pnpm-standalone')
    await exec(pnpm, ['install', '--frozen-lockfile', '--ignore-scripts'], standalone)
    expect(await fs.readFile(resolve(standalone, 'pnpm-lock.yaml'), 'utf8')).toBe(content)
  }, 120000)

  it('writes a lockfile without packages that passes the immutable check', async () => {
    const root = resolve(temporary, 'pnpm-internal')
    const packageManager = `pnpm@${version}`
    await write(resolve(root, 'package.json'), { name: 'root', private: true, packageManager })
    await write(resolve(root, 'pnpm-workspace.yaml'), 'packages:\n  - repos/*\n  - repos/a/packages/*\ninjectWorkspacePackages: true\n')
    await write(resolve(root, 'repos/a/package.json'), { name: 'repo-a', private: true, packageManager })
    await write(resolve(root, 'repos/a/pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
    await execute('git', ['init', '-q'], { cwd: resolve(root, 'repos/a') })
    await write(resolve(root, 'repos/a/packages/consumer/package.json'), { name: 'consumer', version: '1.0.0', dependencies: { peer: 'workspace:*' } })
    await write(resolve(root, 'repos/a/packages/peer/package.json'), { name: 'peer', version: '1.0.0' })
    await install(root, '--lockfile-only')
    const [result] = await syncLockfiles(root, manager, options)
    expect((await read(result.path)).importers['packages/consumer'].dependencies.peer.version).toBe('link:../peer')
    expect((await syncLockfiles(root, manager, { ...options, check: true }))[0].changed).toBe(false)
  }, 120000)

  it('synchronizes from root postinstall', async () => {
    const root = await fixture('pnpm-postinstall')
    await patch(resolve(root, 'package.json'), meta => meta.scripts = { postinstall: `node ${JSON.stringify(resolve(host, 'postinstall.mjs'))}` })
    await install(root)
    const lock = await read(resolve(root, 'repos/a/pnpm-lock.yaml'))
    expect(lock.importers['packages/consumer'].dependencies.semver.version).toBe('7.7.4')
  }, 120000)
})

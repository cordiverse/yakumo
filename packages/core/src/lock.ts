import { promises as fs } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { globby } from 'globby'
import { detectManager, discoverOptions, discoverWorkspaces, inside, readOptional, WorkspaceTree } from './workspace.ts'
import { Adapter, exists, UnsupportedError } from './lockfiles/shared.ts'
import { yarn } from './lockfiles/yarn.ts'
import { npm } from './lockfiles/npm.ts'
import { pnpm } from './lockfiles/pnpm.ts'
import type { Manager } from './index.ts'

export { UnsupportedError } from './lockfiles/shared.ts'
export { seedYarn } from './lockfiles/yarn.ts'
export { seedNpm } from './lockfiles/npm.ts'
export { seedPnpm } from './lockfiles/pnpm.ts'

const execute = promisify(execFile)
const adapters: Record<string, Adapter> = { yarn, npm, pnpm }

export interface LockOptions {
  /** Repository directories, relative to the installation root. Defaults to nested Git roots. */
  repositories?: string[]
  check?: boolean
  /** Fail instead of skipping repositories whose configuration cannot be exported. */
  strict?: boolean
  /** Override the executable for embedding/testing; always runs in the detached staging directory. */
  command?: string[]
  env?: NodeJS.ProcessEnv
  onProgress?(message: string): void
  onWarning?(message: string): void
}

export interface LockResult {
  path: string
  changed: boolean
  /** Reason for leaving this lockfile untouched. */
  skipped?: string
}

/** Whether lockfile synchronization supports a package manager. Versions are checked during synchronization. */
export function supportsLock(manager?: Manager) {
  return !!manager && manager.name in adapters && !(manager.name === 'yarn' && manager.version.startsWith('1.'))
}

export async function managerCommand(root: string, manager: Manager, override?: string[]) {
  if (override) return override
  const path = process.env.npm_execpath
  if (path && process.env.npm_config_user_agent?.startsWith(manager.name + '/')) {
    const executable = resolve(root, path)
    // Lifecycle scripts can expose a shell wrapper or a native binary rather than a JS entry.
    return /\.[cm]?js$/i.test(executable) ? [process.execPath, executable] : [executable]
  }
  return [manager.name]
}

// npm and pnpm pass their configuration to lifecycle scripts as environment variables.
// These settings select a different project or a subset of it, or forbid lockfile updates.
const scopedSettings = new Set([
  'dir', 'filter', 'filter_prod', 'frozen_lockfile', 'global', 'include_workspace_root', 'location',
  'lockfile_dir', 'prefer_frozen_lockfile', 'recursive', 'workspace', 'workspace_root', 'workspaces',
])

export function isolatedEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra, npm_config_update_notifier: 'false' }
  for (const key of Object.keys(env)) {
    const setting = /^(?:npm|pnpm)_config_(.+)$/i.exec(key)?.[1].toLowerCase().replace(/-/g, '_')
    if (/^YARN_(PLUGINS|PROJECT_CWD)$/i.test(key) || (setting && scopedSettings.has(setting))) delete env[key]
  }
  return env
}

async function repositories(tree: WorkspaceTree, explicit?: string[]) {
  if (explicit) {
    const matches = await globby(explicit, {
      cwd: tree.root,
      onlyDirectories: true,
      expandDirectories: false,
      followSymbolicLinks: false,
      ignore: ['**/node_modules/**', '**/.git/**'],
    })
    if (!matches.length && explicit.length) throw new Error('No repositories match lockfiles.repositories')
    return matches.sort().map(path => '/' + path)
  }
  const result = new Set<string>()
  for (const path of Object.keys(tree.packages)) {
    let directory = tree.root + path
    while (directory !== tree.root && inside(tree.root, directory)) {
      if (await exists(resolve(directory, '.git'))) result.add('/' + relative(tree.root, directory))
      directory = dirname(directory)
    }
  }
  return [...result].sort()
}

async function standaloneTree(adapter: Adapter, tree: WorkspaceTree, path: string) {
  const root = tree.root + path
  if (!inside(tree.root, root) || root === tree.root) throw new Error(`Invalid repository: ${path}`)
  const standalone = await discoverWorkspaces(root, adapter.discover)
  if (!standalone.packages['']) throw new UnsupportedError(`missing repository manifest ${root}/package.json`)
  const realRoot = await fs.realpath(root)
  for (const key of Object.keys(standalone.packages)) {
    if (!inside(realRoot, await fs.realpath(root + key))) {
      throw new UnsupportedError(`workspace ${root + key} resolves outside the repository`)
    }
  }
  // Ignored nested clones are absent from a standalone checkout. Do not export their manifests.
  if (await exists(resolve(root, '.git'))) {
    const { stdout } = await execute('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 16 * 1024 * 1024 })
    const files = new Set(stdout.split('\0'))
    for (const key of Object.keys(standalone.packages)) {
      const manifest = key ? key.slice(1) + '/package.json' : 'package.json'
      if (!files.has(manifest)) {
        delete standalone.packages[key]
        delete standalone.groups[key]
      }
    }
  }
  if (!standalone.packages['']) throw new UnsupportedError(`repository manifest ${root}/package.json is ignored by Git`)
  return standalone
}

async function version(command: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const { stdout } = await execute(command[0], [...command.slice(1), '--version'], { cwd, env })
  return stdout.trim()
}

export async function syncLockfiles(root: string, manager?: Manager, options: LockOptions = {}): Promise<LockResult[]> {
  const check = options.check ?? !['', '0', 'false'].includes(process.env.CI ?? '')
  root = resolve(root)
  manager ||= await detectManager(root)
  const adapter = adapters[manager.name]
  if (!adapter) throw new Error(`Lockfile synchronization does not support ${manager.name}`)
  const command = await managerCommand(root, manager, options.command)
  const env = isolatedEnv(options.env)
  adapter.checkEnv?.(env)
  const current = await version(command, root, env)
  if (manager.version && manager.version !== current) throw new Error(`Expected ${manager.name}@${manager.version}, found ${current}`)
  if (!adapter.supports(current)) throw new Error(`Unsupported lockfile adapter: ${manager.name}@${current}; expected ${adapter.versions}`)
  manager = { ...manager, version: current }
  // Corepack commands that have been verified for a version.
  const fallbacks = new Map<string, string[]>()
  const tree = await discoverWorkspaces(root, discoverOptions(manager))
  const targets = await repositories(tree, options.repositories)
  if (!targets.length) return []
  const { filename } = adapter
  const rootLock = await readOptional(resolve(root, filename))
  if (!rootLock) throw new Error(`Missing ${root}/${filename}; install the root first`)
  const temporary = await fs.mkdtemp(resolve(tmpdir(), 'yakumo-lock-'))
  const outputs: { path: string; before?: string; content: string }[] = []
  const skipped: LockResult[] = []
  const warn = options.onWarning ?? ((message: string) => console.warn(message))
  try {
    for (const [index, path] of targets.entries()) {
      options.onProgress?.(`Resolving ${path.slice(1)}/${filename}`)
      const target = resolve(root + path, filename)
      const directory = resolve(temporary, String(index))
      let targetManager: Manager
      let projects: string[]
      try {
        targetManager = await detectManager(root + path, manager)
        if (targetManager.name !== manager.name) {
          throw new UnsupportedError(`${root + path}: repository uses ${targetManager.name}, but the installation root uses ${manager.name}`)
        }
        targetManager = { ...targetManager, version: targetManager.version || manager.version }
        if (!adapter.supports(targetManager.version)) {
          throw new UnsupportedError(`${root + path}: standalone lockfile generation requires ${adapter.versions}`)
        }
        const standalone = await standaloneTree(adapter, tree, path)
        await adapter.stage(standalone, directory, targetManager)
        projects = Object.keys(standalone.packages).map(key => key.slice(1))
      } catch (error) {
        // Configuration-level limitations skip one repository; resolution failures still abort.
        if (!(error instanceof UnsupportedError) || options.strict) throw error
        const present = await readOptional(target) !== undefined
        warn(`Skipping ${path.slice(1)}: ${error.message}${present ? `; existing ${filename} left unchanged` : ''}`)
        skipped.push({ path: target, changed: false, skipped: error.message })
        continue
      }
      // The command of the root may select another version in the staging directory,
      // for example through Corepack or the version management of pnpm.
      const expected = targetManager.version
      let targetCommand = command
      if (await version(command, directory, env) !== expected) {
        targetCommand = fallbacks.get(expected)!
        if (!targetCommand) {
          targetCommand = ['corepack', `${manager.name}@${expected}`]
          const found = await version(targetCommand, directory, env)
          if (found !== expected) throw new Error(`Expected ${manager.name}@${expected}, found ${found}`)
          fallbacks.set(expected, targetCommand)
        }
      }
      const before = await readOptional(target)
      await fs.writeFile(resolve(directory, filename), adapter.seed(rootLock, before, path.slice(1), projects))
      try {
        await execute(targetCommand[0], [...targetCommand.slice(1), ...adapter.args], {
          cwd: directory,
          env: { ...env, ...adapter.env?.(directory) },
          maxBuffer: 16 * 1024 * 1024,
        })
      } catch (error) {
        const failure = error as Error & { stdout?: string; stderr?: string }
        throw new Error(`Cannot resolve standalone lockfile for ${root + path}:\n${failure.stdout || ''}${failure.stderr || failure.message}`)
      }
      const content = await readOptional(resolve(directory, filename))
      if (content === undefined) throw new Error(`${manager.name} did not write ${filename} for ${root + path}`)
      adapter.verify(content)
      outputs.push({ path: target, before, content })
    }
    // Resolve everything before writing anything, and refuse to overwrite concurrent edits.
    if (await fs.readFile(resolve(root, filename), 'utf8') !== rootLock) throw new Error('Root lockfile changed during synchronization; retry')
    for (const [path, meta] of Object.entries(tree.packages)) {
      const current = JSON.parse(await fs.readFile(resolve(root + path, 'package.json'), 'utf8'))
      if (JSON.stringify(current) !== JSON.stringify(meta)) throw new Error(`${root + path}/package.json changed during synchronization; retry`)
    }
    for (const output of outputs) {
      if (await readOptional(output.path) !== output.before) throw new Error(`${output.path} changed during synchronization; retry`)
    }
    const results: LockResult[] = outputs.map(output => ({ path: output.path, changed: output.content !== output.before }))
    if (check && results.some(result => result.changed)) {
      throw new Error(`Outdated lockfiles:\n${results.filter(result => result.changed).map(result => result.path).join('\n')}`)
    }
    if (!check) {
      for (const output of outputs) {
        if (output.before === output.content) continue
        const staging = output.path + `.yakumo-${randomUUID()}.tmp`
        try {
          await fs.writeFile(staging, output.content, { flag: 'wx' })
          await fs.rename(staging, output.path)
        } finally {
          await fs.rm(staging, { force: true })
        }
      }
    }
    return [...results, ...skipped].sort((a, b) => a.path.localeCompare(b.path))
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

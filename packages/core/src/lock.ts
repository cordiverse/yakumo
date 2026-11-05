import { promises as fs } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { parseSyml, stringifySyml } from '@yarnpkg/parsers'
import { globby } from 'globby'
import { validRange } from 'semver'
import { detectManager, discoverWorkspaces, inside, readOptional, WorkspaceTree } from './workspace.ts'
import type { Manager, PackageJson } from './index.ts'

const execute = promisify(execFile)
const dependencyTypes = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const

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

/** A repository uses a configuration that standalone lockfile export does not support. */
export class UnsupportedError extends Error {
  name = 'UnsupportedError'
}

export async function managerCommand(root: string, manager: Manager, override?: string[]) {
  if (override) return override
  const path = process.env.npm_execpath
  if (path && process.env.npm_config_user_agent?.startsWith(manager.name + '/')) {
    const executable = resolve(root, path)
    // Yarn lifecycle scripts can expose a shell wrapper rather than a JS entry.
    return /\.[cm]?js$/i.test(executable) ? [process.execPath, executable] : [executable]
  }
  return [manager.name]
}

export function isolatedEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
    ...extra,
    YARN_ENABLE_SCRIPTS: 'false',
    YARN_ENABLE_IMMUTABLE_INSTALLS: 'false',
    // The executable has already been selected; never let a shadow manifest switch it.
    COREPACK_ENABLE_PROJECT_SPEC: '0',
  }
  for (const key of Object.keys(env)) {
    if (/^YARN_(PLUGINS|PROJECT_CWD)$/i.test(key)) delete env[key]
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
      if (await fs.lstat(resolve(directory, '.git')).catch(() => undefined)) result.add('/' + relative(tree.root, directory))
      directory = dirname(directory)
    }
  }
  return [...result].sort()
}

async function standaloneTree(tree: WorkspaceTree, path: string) {
  const root = tree.root + path
  if (!inside(tree.root, root) || root === tree.root) throw new Error(`Invalid repository: ${path}`)
  const standalone = await discoverWorkspaces(root, { recursive: true })
  if (!standalone.packages['']) throw new UnsupportedError(`missing repository manifest ${root}/package.json`)
  const realRoot = await fs.realpath(root)
  for (const key of Object.keys(standalone.packages)) {
    if (!inside(realRoot, await fs.realpath(root + key))) {
      throw new UnsupportedError(`workspace ${root + key} resolves outside the repository`)
    }
  }
  // Ignored nested clones are absent from a standalone checkout. Do not export their manifests.
  if (await fs.lstat(resolve(root, '.git')).catch(() => undefined)) {
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

function assertRegistrySpecifier(specifier: string, label: string) {
  // This first adapter supports registry ranges/tags and npm aliases. Protocols that
  // depend on repository files need a separate staging policy.
  let range = specifier.replace(/^npm:/, '')
  if (specifier.startsWith('npm:')) range = range.replace(/^(@[^/]+\/[^@]+|[^@]+)@/, '')
  if (validRange(range) || /^[a-zA-Z][\w.-]*$/.test(range)) return
  throw new UnsupportedError(`${label}: cannot export ${specifier}; only registry dependencies and internal workspace references are supported`)
}

function assertPortable(tree: WorkspaceTree) {
  const names = new Set(Object.values(tree.packages).map(meta => meta.name))
  for (const [path, meta] of Object.entries(tree.packages)) {
    for (const type of dependencyTypes) {
      for (const [name, specifier] of Object.entries(meta[type] || {})) {
        if (specifier.startsWith('workspace:')) {
          const target = specifier.slice(10)
          const alias = /^(@[^/]+\/[^@]+|[^@]+)@/.exec(target)?.[1]
          const relativeTarget = relative(tree.root, resolve(tree.root + path, target))
          const internal = target.startsWith('.') ? tree.packages[relativeTarget ? '/' + relativeTarget : ''] : names.has(alias || name)
          if (!internal) throw new UnsupportedError(`${tree.root + path}: ${name}@${specifier} crosses a repository boundary; use a published version range`)
        } else {
          assertRegistrySpecifier(specifier, `${tree.root + path}: ${name}`)
        }
      }
    }
  }
}

async function stage(tree: WorkspaceTree, directory: string) {
  assertPortable(tree)
  for (const [path, original] of Object.entries(tree.packages)) {
    const meta = structuredClone(original) as PackageJson
    for (const specifier of Object.values<string>((meta as any).resolutions || {})) {
      assertRegistrySpecifier(specifier, `${tree.root + path}: resolutions`)
    }
    await fs.mkdir(directory + path, { recursive: true })
    await fs.writeFile(resolve(directory + path, 'package.json'), JSON.stringify(meta, null, 2) + '\n')
  }
  const rc = await readOptional(resolve(tree.root, '.yarnrc.yml'))
  const config = rc === undefined ? {} : parseSyml(rc)
  if (config.plugins?.length || config.yarnPath || config.patchFolder || config.injectEnvironmentFiles?.length) {
    throw new UnsupportedError(`${tree.root}: custom Yarn plugins, releases, environment files and patches need an explicit standalone layout`)
  }
  for (const extension of Object.values<any>(config.packageExtensions || {})) {
    for (const type of dependencyTypes) {
      for (const specifier of Object.values<string>(extension[type] || {})) assertRegistrySpecifier(specifier, `${tree.root}: packageExtensions`)
    }
  }
  delete config.plugins
  await fs.writeFile(resolve(directory, '.yarnrc.yml'), stringifySyml({
    ...config,
    installStatePath: resolve(directory, '.yarn/install-state.gz'),
    enableScripts: false,
    enableImmutableInstalls: false,
    enableTelemetry: false,
  }))
}

/** Reuse registry records, never workspace locators rooted in a different project. */
export function seedYarn(root: string, previous?: string) {
  const source = parseSyml(root)
  if (!source.__metadata) throw new Error('Yarn Classic lockfiles are not supported')
  const seed: Record<string, any> = { __metadata: source.__metadata }
  for (const lock of [previous ? parseSyml(previous) : {}, source]) {
    for (const [key, entry] of Object.entries<any>(lock)) {
      if (!entry?.resolution || !/^(@[^/]+\/)?[^@]+@npm:/.test(entry.resolution)) continue
      for (const descriptor of key.split(/, /)) seed[descriptor] = entry
    }
  }
  return stringifySyml(seed)
}

export async function syncLockfiles(root: string, manager?: Manager, options: LockOptions = {}): Promise<LockResult[]> {
  const check = options.check ?? !['', '0', 'false'].includes(process.env.CI ?? '')
  root = resolve(root)
  manager ||= await detectManager(root)
  if (manager.name !== 'yarn') throw new Error(`Lockfile synchronization currently supports Yarn 4, not ${manager.name}`)
  const command = await managerCommand(root, manager, options.command)
  const env = isolatedEnv(options.env)
  if (env.YARN_RC_FILENAME && env.YARN_RC_FILENAME !== '.yarnrc.yml') {
    throw new Error('Custom YARN_RC_FILENAME is not supported by lockfile synchronization')
  }
  const { stdout } = await execute(command[0], [...command.slice(1), '--version'], { cwd: root, env })
  const version = stdout.trim()
  if (manager.version && manager.version !== version) throw new Error(`Expected ${manager.name}@${manager.version}, found ${version}`)
  if (!/^4\./.test(version)) throw new Error(`Unsupported lockfile adapter: ${manager.name}@${version}; expected Yarn 4`)
  manager = { ...manager, version }
  const commands = new Map<string, string[]>([[version, command]])
  const tree = await discoverWorkspaces(root, { recursive: true })
  const targets = await repositories(tree, options.repositories)
  if (!targets.length) return []
  const filename = 'yarn.lock'
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
      let standalone: WorkspaceTree
      let targetManager: Manager
      try {
        standalone = await standaloneTree(tree, path)
        targetManager = await detectManager(standalone.root, manager)
        if (targetManager.name !== 'yarn' || !/^4\./.test(targetManager.version)) {
          throw new UnsupportedError(`${standalone.root}: standalone lockfile generation requires Yarn 4`)
        }
        await stage(standalone, directory)
      } catch (error) {
        // Configuration-level limitations skip one repository; resolution failures still abort.
        if (!(error instanceof UnsupportedError) || options.strict) throw error
        const exists = await readOptional(target) !== undefined
        warn(`Skipping ${path.slice(1)}: ${error.message}${exists ? `; existing ${filename} left unchanged` : ''}`)
        skipped.push({ path: target, changed: false, skipped: error.message })
        continue
      }
      let targetCommand = commands.get(targetManager.version)
      if (!targetCommand) {
        targetCommand = ['corepack', `yarn@${targetManager.version}`]
        const { stdout } = await execute(targetCommand[0], [...targetCommand.slice(1), '--version'], { cwd: standalone.root, env })
        if (stdout.trim() !== targetManager.version) throw new Error(`Expected Yarn ${targetManager.version}, found ${stdout.trim()}`)
        commands.set(targetManager.version, targetCommand)
      }
      const before = await readOptional(target)
      const seed = seedYarn(rootLock, before)
      await fs.writeFile(resolve(directory, filename), seed)
      const args = ['install', '--mode=update-lockfile']
      try {
        await execute(targetCommand[0], [...targetCommand.slice(1), ...args], {
          cwd: directory,
          env: { ...env, YARN_INSTALL_STATE_PATH: resolve(directory, '.yarn/install-state.gz') },
          maxBuffer: 16 * 1024 * 1024,
        })
      } catch (error) {
        const failure = error as Error & { stdout?: string; stderr?: string }
        throw new Error(`Cannot resolve standalone lockfile for ${root + path}:\n${failure.stdout || ''}${failure.stderr || failure.message}`)
      }
      outputs.push({ path: target, before, content: await fs.readFile(resolve(directory, filename), 'utf8') })
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

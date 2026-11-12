import { Context, Inject, Service } from 'cordis'
import { Input } from '@cordisjs/cli'
import detect from 'detect-indent'
import { getRegistry, spawnAsync } from './utils.ts'
import { promises as fs, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { deduplicate, Dict, makeArray } from 'cosmokit'
import { detectManager, discoverOptions, discoverWorkspaces, WorkspaceTree, writePnpmPackages } from './workspace.ts'
import { LockOptions, syncLockfiles } from './lock.ts'
import * as lock from './plugins/lock.ts'
import * as list from './plugins/list.ts'
import * as prepare from './plugins/prepare.ts'
import * as publish from './plugins/publish.ts'
import * as run from './plugins/run.ts'
import * as test from './plugins/test.ts'
import * as upgrade from './plugins/upgrade.ts'
import * as version from './plugins/version.ts'

export * from 'cordis'
export * from './utils.ts'

declare module 'cordis' {
  interface Context {
    yakumo: Yakumo
  }

  interface Intercept {
    yakumo: Yakumo.Intercept
  }
}

export const cwd = process.cwd()
const content = readFileSync(`${cwd}/package.json`, 'utf8')
export const meta: PackageJson = JSON.parse(content)

export interface PackageConfig {
  lockfiles?: Pick<LockOptions, 'repositories' | 'strict'>
}

export interface Manager {
  name: string
  version: string
}

export type DependencyType = 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies'

export interface PackageJson extends Partial<Record<DependencyType, Dict<string>>> {
  name: string
  type?: 'module' | 'commonjs'
  main?: string
  module?: string
  bin?: string | Dict<string>
  exports?: PackageJson.Exports
  description?: string
  private?: boolean
  version: string
  workspaces?: string[]
  scripts?: Dict<string>
  yakumo?: PackageConfig
  peerDependenciesMeta?: Dict<{ optional?: boolean }>
}

export namespace PackageJson {
  export type Exports = string | { [key: string]: Exports }
}

export interface LocateOptions {
  includeRoot?: boolean
  filter?(meta: PackageJson, path: string): boolean
}

export namespace Yakumo {
  export interface Intercept {
    alias?: Dict<string | string[]>
    exclude?: string[]
  }

  export interface Config extends Intercept {
    commands?: Dict
    pipeline?: Dict<string[]>
  }
}

@Inject('cli')
export default class Yakumo extends Service {
  cwd: string
  manager!: Manager
  workspaces!: Dict<PackageJson>
  workspaceTree!: WorkspaceTree
  indent = detect(content).indent
  commands: Dict = {}
  private registryTask?: Promise<string>

  constructor(public ctx: Context, public config: Yakumo.Config = {}) {
    super(ctx, 'yakumo')
    this.cwd = cwd

    ctx.cli
      .command('', 'Manage complex workspaces with ease')
      .option('-v, --version', 'Show version')
      .action(({ options }) => {
        if (options.version) {
          const require = createRequire(import.meta.url)
          const { version } = require('../package.json')
          return `yakumo ${version}`
        }
      })

    // Register pipeline commands (command aliases that run multiple sub-commands)
    for (const name in config.pipeline || {}) {
      ctx.cli
        .command(`${name} [...args]`, { unknownOption: 'allow' })
        .action(async ({ args, options }) => {
          const tasks = config.pipeline![name]
          for (const task of tasks) {
            const output = await ctx.cli.execute(new Input.String(task), args, options)
            if (output) console.log(output)
          }
        })
    }

    list.apply(ctx)
    lock.apply(ctx)
    prepare.apply(ctx)
    publish.apply(ctx)
    run.apply(ctx)
    test.apply(ctx)
    upgrade.apply(ctx)
    version.apply(ctx)
  }

  async initialize() {
    this.manager = await detectManager(this.cwd)
    this.workspaceTree = await discoverWorkspaces(this.cwd, discoverOptions(this.manager))
    this.workspaces = this.workspaceTree.packages
  }

  resolveIntercept(): Yakumo.Intercept {
    let result = this.config
    let intercept = this.ctx[Context.intercept]
    while (intercept) {
      result = {
        ...result,
        ...intercept.yakumo,
        alias: {
          ...result.alias,
          ...intercept.yakumo?.alias,
        },
        exclude: [
          ...result.exclude || [],
          ...intercept.yakumo?.exclude || [],
        ],
      }
      intercept = Object.getPrototypeOf(intercept)
    }
    return result
  }

  locate(name: string | string[], options: LocateOptions = {}): string[] {
    const { alias = {}, exclude } = this.resolveIntercept()
    const defaultFilter = options.filter || ((meta, path) => options.includeRoot || !this.workspaceTree.groups[path])
    const filter = (meta: PackageJson, path: string) => {
      return defaultFilter(meta, path) && !exclude?.some((pattern) => {
        return new RegExp('^/' + pattern.replace(/\*/g, '[^/]+') + '$').test(path)
      })
    }
    if (Array.isArray(name)) {
      if (!name.length) {
        return Object.keys(this.workspaces).filter((folder) => {
          return filter(this.workspaces[folder], folder)
        })
      } else {
        return deduplicate(name.flatMap((name) => this.locate(name, options)))
      }
    }

    if (alias[name]) {
      return makeArray(alias[name]).map((path) => {
        if (!this.workspaces[path]) {
          throw new Error(`cannot find workspace ${path} resolved by ${name}`)
        }
        return path
      })
    }

    for (const key in alias) {
      if (!key.endsWith('*')) continue
      if (!name.startsWith(key.slice(0, -1))) continue
      const results = makeArray(alias[key])
        .map((path) => path.slice(0, -1) + name.slice(key.length - 1))
        .filter((path) => this.workspaces[path])
      if (results.length) return results
    }

    const folderMatches: string[] = []
    const nameMatches: string[] = []
    for (const folder in this.workspaces) {
      const meta = this.workspaces[folder]
      if (!filter(meta, folder)) continue
      if (folder.slice(folder.lastIndexOf('/') + 1) === name) {
        folderMatches.push(folder)
      } else if (meta.name === name) {
        nameMatches.push(folder)
      }
    }
    const targets = deduplicate([...folderMatches, ...nameMatches])

    if (!targets.length) {
      throw new Error(`cannot find workspace "${name}"`)
    } else if (targets.length > 1) {
      const lines = targets.map((path) => {
        const meta = this.workspaces[path]
        return meta.name === name && path.slice(path.lastIndexOf('/') + 1) !== name
          ? `  - package "${name}" at ${path}`
          : `  - folder ${path} (package "${meta.name}")`
      })
      const onlyFolders = nameMatches.length === 0
      const hint = onlyFolders
        ? `hint: disambiguate by package name (${folderMatches.map((p) => `"${this.workspaces[p].name}"`).join(', ')}) or add an alias in yakumo.yml`
        : `hint: add an alias in yakumo.yml to disambiguate`
      throw new Error(`ambiguous name "${name}":\n${lines.join('\n')}\n${hint}`)
    }

    return targets
  }

  async save(path: string) {
    const content = JSON.stringify(this.workspaces[path], null, this.indent) + '\n'
    await fs.writeFile(`${this.cwd}${path}/package.json`, content)
  }

  /** Write the workspace patterns of the root group to the file that the package manager reads. */
  async saveWorkspaces(patterns: string[]) {
    this.workspaceTree.groups[''] = { path: '', patterns }
    if (this.manager.name === 'pnpm') return writePnpmPackages(this.cwd, patterns)
    this.workspaces[''].workspaces = patterns
    await this.save('')
  }

  async syncLocks(options: LockOptions = {}) {
    return syncLockfiles(this.cwd, this.manager, {
      ...this.workspaces[''].yakumo?.lockfiles,
      onProgress: message => console.log(message),
      ...options,
    })
  }

  /** Registry URL of the package manager, read once per instance. */
  registry() {
    return this.registryTask ||= getRegistry(this.manager, this.cwd)
  }

  async install() {
    const code = await spawnAsync([this.manager.name, 'install'], { cwd: this.cwd })
    if (code) process.exit(code)
  }
}

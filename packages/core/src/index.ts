import * as cordis from 'cordis'
import globby from 'globby'
import yargs from 'yargs-parser'
import detect from 'detect-indent'
import { manager, spawnAsync } from './utils.js'
import kleur from 'kleur'
import { promises as fs, readFileSync } from 'node:fs'
import { Dict, makeArray } from 'cosmokit'
import list from './plugins/list.js'
import prepare from './plugins/prepare.js'
import publish from './plugins/publish.js'
import test from './plugins/test.js'
import upgrade from './plugins/upgrade.js'
import version from './plugins/version.js'

export * from './plugins/prepare.js'
export * from './plugins/publish.js'
export * from './plugins/test.js'
export * from './plugins/upgrade.js'
export * from './plugins/version.js'
export * from './utils.js'

export const cwd = process.cwd()
const content = readFileSync(`${cwd}/package.json`, 'utf8')
export const meta: PackageJson = JSON.parse(content)

export interface PackageConfig {}

export interface WorkspaceOptions {
  ignores: (string | RegExp)[]
}

export interface ProjectConfig {
  alias?: Dict<string | string[]>
  commands?: Dict
  pipeline?: Dict<string[]>
  workspace?: WorkspaceOptions
}

export interface Manager {
  name: string
  version: string
}

export interface Arguments extends yargs.Arguments {
  config: Options
  _: string[]
}

export interface Options extends yargs.Options {}

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
  yakumo?: PackageConfig
  peerDependenciesMeta?: Dict<{ optional?: boolean }>
}

export namespace PackageJson {
  export type Exports = string | { [key: string]: Exports }
}

export interface Events<C extends Context = Context> extends cordis.Events<C> {}

export interface Context {
  [Context.events]: Events<this>
  yakumo: Yakumo
  register(name: string, callback: () => void, options?: Options): void
}

export class Context extends cordis.Context {
  constructor(config: any) {
    super(config)
    this.plugin(Yakumo, config)
  }
}

export interface LocateOptions {
  includeRoot?: boolean
  filter?(meta: PackageJson, path: string): boolean
}

export default class Yakumo {
  cwd: string
  args = process.argv.slice(2)
  argv!: Arguments
  manager: Manager
  workspaces!: Dict<PackageJson>
  indent = detect(content).indent
  commands: Dict = {}

  constructor(ctx: Context, public config: ProjectConfig) {
    ctx.provide('yakumo', undefined, true)
    ctx.mixin('yakumo', ['register'])
    ctx.yakumo = this
    this.cwd = cwd
    this.manager = manager

    ctx.plugin(list)
    ctx.plugin(prepare)
    ctx.plugin(publish)
    ctx.plugin(test)
    ctx.plugin(upgrade)
    ctx.plugin(version)

    for (const name in config.pipeline || {}) {
      this.register(name, async () => {
        const tasks = config.pipeline![name]
        for (const task of tasks) {
          const [name, ...args] = task.split(/\s+/g)
          await this.execute(name, ...args)
        }
      })
    }

    ctx.on('ready', () => this.start())
  }

  register(name: string, callback: () => void, options: Options = {}) {
    this.commands[name] = [callback, options]
  }

  async initialize(argv: Arguments) {
    this.argv = argv
    const folders = await globby(meta.workspaces || [], {
      cwd,
      onlyDirectories: true,
      expandDirectories: false,
    })
    folders.unshift('')

    const ignores = this.config.workspace?.ignores ?? []

    this.workspaces = Object.fromEntries((await Promise.all(folders.map(async (path) => {
      if (path) path = '/' + path
      try {
        const content = await fs.readFile(`${cwd}${path}/package.json`, 'utf8')
        return [path, JSON.parse(content)] as [string, PackageJson]
      } catch {}
      return null! // workaround silly strictNullChecks
    }))).filter(Boolean).filter(([path]) => !ignores.some(ignore => {
      if (typeof ignore === 'string') {
        return path === ignore
      } else {
        return ignore.test(path)
      }
    })))
  }

  locate(name: string | string[], options: LocateOptions = {}): string[] {
    const filter = options.filter || ((meta) => options.includeRoot || !meta.workspaces)
    if (Array.isArray(name)) {
      if (!name.length) {
        return Object.keys(this.workspaces).filter((folder) => {
          return filter(this.workspaces[folder], folder)
        })
      } else {
        return name.flatMap((name) => this.locate(name, options))
      }
    }

    if (this.config.alias?.[name]) {
      return makeArray(this.config.alias[name]).map((path) => {
        if (!this.workspaces[path]) {
          throw new Error(`cannot find workspace ${path} resolved by ${name}`)
        }
        return path
      })
    }

    const targets = Object.keys(this.workspaces).filter((folder) => {
      if (!filter(this.workspaces[folder], folder)) return
      return folder.endsWith('/' + name)
    })

    if (!targets.length) {
      throw new Error(`cannot find workspace "${name}"`)
    } else if (targets.length > 1) {
      throw new Error(`ambiguous workspace "${name}": ${targets.join(', ')}`)
    }

    return targets
  }

  async save(path: string) {
    const content = JSON.stringify(this.workspaces[path], null, this.indent) + '\n'
    await fs.writeFile(`${cwd}${path}/package.json`, content)
  }

  async execute(name: string, ...args: string[]) {
    if (!this.commands[name]) {
      console.error(kleur.red(`unknown command: ${name}`))
      process.exit(1)
    }

    const [callback, options] = this.commands[name]
    const argv = yargs([...this.args.slice(1), ...args], options) as Arguments
    argv.config = options
    await this.initialize(argv)
    return callback()
  }

  async start() {
    if (!this.args.length) {
      console.log('yakumo')
      process.exit(0)
    }
    await this.execute(this.args[0])
  }

  async install() {
    const agent = manager?.name || 'npm'
    const code = await spawnAsync([agent, 'install'])
    if (code) process.exit(code)
  }
}

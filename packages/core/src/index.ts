import globby from 'globby'
import which from 'which-pm-runs'
import yargs from 'yargs-parser'
import detect from 'detect-indent'
import { load } from 'js-yaml'
import { promises as fsp, readFileSync } from 'fs'
import { Module } from 'module'
import { Awaitable, Dict, makeArray, pick } from 'cosmokit'

export * from './utils'

export const cwd = process.cwd()
const content = readFileSync(`${cwd}/package.json`, 'utf8')
export const meta: PackageJson = JSON.parse(content)

export const configRequire = Module.createRequire(cwd + '/package.json')

export function requireSafe(id: string) {
  try {
    return configRequire(id)
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') throw e
  }
}

function loadConfig(): ProjectConfig {
  let content: string
  try {
    content = readFileSync(`${cwd}/yakumo.yml`, 'utf8')
  } catch {}

  return {
    alias: {},
    require: [],
    commands: {},
    ...content && load(content) as any,
  }
}

export interface Commands {}

export interface PackageConfig {}

export interface ProjectConfig {
  alias?: Dict<string | string[]>
  require?: string[]
  commands?: Commands
  pipeline?: Dict<string[]>
}

export const config = loadConfig()

export interface Manager {
  name: string
  version: string
}

export class Project {
  cwd: string
  argv: Arguments
  config: ProjectConfig
  manager: Manager
  targets: Record<string, PackageJson>
  workspaces: Record<string, PackageJson>
  indent = detect(content).indent

  constructor() {
    this.cwd = cwd
    this.config = config
    this.manager = which()
  }

  require(id: string) {
    return configRequire(id)
  }

  async initialize(argv: Arguments) {
    this.argv = argv
    const folders = await globby(meta.workspaces || [], {
      cwd,
      onlyDirectories: true,
      expandDirectories: false,
    })
    folders.unshift('')

    this.workspaces = Object.fromEntries(folders.map((path) => {
      if (path) path = '/' + path
      try {
        return [path, require(`${cwd}${path}/package.json`)] as [string, PackageJson]
      } catch {}
    }).filter(Boolean))

    if (!argv._.length || argv.config.manual) {
      this.targets = { ...this.workspaces }
      return
    }

    this.targets = pick(this.workspaces, argv._.flatMap((name: string) => {
      return this.locate(name)
    }))
  }

  locate(name: string) {
    if (config.alias[name]) {
      return makeArray(config.alias[name]).map((path) => {
        if (!this.workspaces[path]) {
          throw new Error(`cannot find workspace ${path} resolved by ${name}`)
        }
        return path
      })
    }

    const targets = Object.keys(this.workspaces).filter((folder) => {
      if (this.workspaces[folder].private) return
      const [last] = folder.split('/').reverse()
      return name === last
    })

    if (!targets.length) {
      throw new Error(`cannot find workspace "${name}"`)
    } else if (targets.length > 1) {
      throw new Error(`ambiguous workspace "${name}": ${targets.join(', ')}`)
    }

    return targets
  }

  async emit(name: string, ...args: any) {
    await Promise.all((hooks[name] || []).map((callback) => callback.call(this, ...args)))
  }

  async save(path: string) {
    const content = JSON.stringify(this.workspaces[path], null, this.indent) + '\n'
    await fsp.writeFile(`${cwd}${path}/package.json`, content)
  }
}

export interface Hooks {}

export const hooks: { [K in keyof Hooks]: Hooks[K][] } = {}

export function addHook<K extends keyof Hooks>(name: K, callback: Hooks[K]) {
  (hooks[name] ||= [] as never).push(callback)
}

type CommandCallback = (project: Project) => Awaitable<void>

export interface Arguments extends yargs.Arguments {
  config: Options
}

export interface Options extends yargs.Options {
  manual?: boolean
}

export const commands: Record<string, [CommandCallback, Options]> = {}

export function register(name: string, callback: (project: Project) => void, options: Options = {}) {
  commands[name] = [callback, options]
}

export type DependencyType = 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies'

export interface PackageJson extends Partial<Record<DependencyType, Record<string, string>>> {
  name: string
  main?: string
  module?: string
  bin?: string | Dict<string>
  exports?: PackageJson.Exports
  description?: string
  private?: boolean
  version?: string
  workspaces?: string[]
  yakumo?: PackageConfig
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

export namespace PackageJson {
  export type Exports = string | { [key: string]: Exports } 
}

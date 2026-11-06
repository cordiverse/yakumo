import { promises as fs } from 'node:fs'
import { relative, resolve } from 'node:path'
import { validRange } from 'semver'
import { readOptional, type DiscoverOptions, type WorkspaceTree } from '../workspace.ts'
import type { Manager, PackageJson } from '../index.ts'

export const dependencyTypes = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const

/** A repository uses a configuration that standalone lockfile export does not support. */
export class UnsupportedError extends Error {
  name = 'UnsupportedError'
}

export interface Adapter {
  /** Name of the lockfile in a project root. */
  filename: string
  /** Package manager versions that write the latest lockfile format, for messages. */
  versions: string
  supports(version: string): boolean
  discover: DiscoverOptions
  /** Reject environment settings that the staging directory cannot reproduce. */
  checkEnv?(env: NodeJS.ProcessEnv): void
  /** Validate the configuration of a repository and write its standalone copy into `directory`. */
  stage(tree: WorkspaceTree, directory: string, manager: Manager): Promise<void>
  /**
   * Build the initial lockfile of a staging directory from the root lockfile and the previous
   * repository lockfile. `prefix` is the repository directory relative to the installation root,
   * and `projects` are the staged workspace directories relative to the repository, `''` for its root.
   */
  seed(root: string, previous: string | undefined, prefix: string, projects: string[]): string
  /** Arguments of the command that updates the lockfile without installing packages. */
  args: string[]
  env?(directory: string): NodeJS.ProcessEnv
  /** Throw if a generated lockfile does not use the latest format. */
  verify(content: string): void
}

export function major(version: string) {
  return Number(/^(\d+)\./.exec(version)?.[1])
}

export function assertRegistrySpecifier(specifier: string, label: string) {
  // Registry ranges/tags and npm aliases resolve identically in any directory. Protocols
  // that depend on repository files need a separate staging policy.
  let range = specifier.replace(/^npm:/, '')
  if (specifier.startsWith('npm:')) range = range.replace(/^(@[^/]+\/[^@]+|[^@]+)@/, '')
  if (validRange(range) || /^[a-zA-Z][\w.-]*$/.test(range)) return
  throw new UnsupportedError(`${label}: cannot export ${specifier}; only registry dependencies and internal workspace references are supported`)
}

export function assertPortable(tree: WorkspaceTree, check = assertRegistrySpecifier) {
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
          check(specifier, `${tree.root + path}: ${name}`)
        }
      }
    }
  }
}

/** Validate the dependency specifiers of a `packageExtensions` setting. */
export function assertExtensions(extensions: Record<string, any> | undefined, label: string) {
  for (const extension of Object.values<any>(extensions || {})) {
    for (const type of dependencyTypes) {
      for (const specifier of Object.values<string>(extension?.[type] || {})) assertRegistrySpecifier(specifier, label)
    }
  }
}

export async function writeManifests(tree: WorkspaceTree, directory: string, transform?: (meta: PackageJson, path: string) => void) {
  for (const [path, original] of Object.entries(tree.packages)) {
    const meta = structuredClone(original) as PackageJson
    transform?.(meta, path)
    await fs.mkdir(directory + path, { recursive: true })
    await fs.writeFile(resolve(directory + path, 'package.json'), JSON.stringify(meta, null, 2) + '\n')
  }
}

export async function copyOptional(source: string, target: string) {
  const content = await readOptional(source)
  if (content !== undefined) await fs.writeFile(target, content)
}

export async function exists(path: string) {
  return !!await fs.lstat(path).catch(() => undefined)
}

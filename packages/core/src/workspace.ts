import { promises as fs } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { globby } from 'globby'
import type { Manager, PackageJson } from './index.ts'

export interface WorkspaceGroup {
  path: string
  patterns: string[]
}

export interface WorkspaceTree {
  root: string
  packages: Record<string, PackageJson>
  groups: Record<string, WorkspaceGroup>
}

export interface DiscoverOptions {
  /**
   * Expand `workspaces` declared by nested workspaces, as Yarn 2+ does.
   * npm and Yarn Classic only read the root declaration.
   */
  recursive?: boolean
}

export async function readOptional(path: string) {
  try {
    return await fs.readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export function inside(root: string, path: string) {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'))
}

export function isBerry(manager?: Manager) {
  return manager?.name === 'yarn' && !manager.version.startsWith('1.')
}

export async function detectManager(root: string, fallback?: Manager): Promise<Manager> {
  const meta = JSON.parse(await fs.readFile(resolve(root, 'package.json'), 'utf8'))
  const match = /^(yarn|pnpm|npm)@([^+]+)/.exec(meta.packageManager || '')
  if (match) return { name: match[1], version: match[2] }
  if (!fallback && await readOptional(resolve(root, 'yarn.lock')) !== undefined) return { name: 'yarn', version: '' }
  return fallback || { name: 'npm', version: '' }
}

function getPatterns(meta: PackageJson, directory: string) {
  const value = meta.workspaces as unknown
  // Yarn Classic also accepts `{ packages: [...] }`.
  const patterns = Array.isArray(value) ? value : (value as any)?.packages
  if (!Array.isArray(patterns) || patterns.some(p => typeof p !== 'string' || isAbsolute(p.replace(/^!/, '')) || p.split('/').includes('..'))) {
    throw new Error(`Invalid workspace patterns in ${directory}`)
  }
  return patterns as string[]
}

/** Keep nested group membership separate from repository and installation boundaries. */
export async function discoverWorkspaces(root: string, options: DiscoverOptions = {}): Promise<WorkspaceTree> {
  root = resolve(root)
  const tree: WorkspaceTree = { root, packages: {}, groups: {} }
  const queue = ['']
  // Dedupe by real path so that symlinked groups cannot recurse forever.
  const seen = new Set<string>()
  while (queue.length) {
    const path = queue.shift()!
    const directory = root + path
    const real = await fs.realpath(directory)
    if (seen.has(real)) continue
    seen.add(real)
    const content = await readOptional(resolve(directory, 'package.json'))
    if (content === undefined) continue
    const meta: PackageJson = JSON.parse(content)
    tree.packages[path] = meta
    if (!meta.workspaces) continue
    const group: WorkspaceGroup = { path, patterns: getPatterns(meta, directory) }
    tree.groups[path] = group
    if (path && !options.recursive) continue
    // Like Yarn, negated patterns only apply to the group that declares them.
    const prefix = path ? path.slice(1) + '/' : ''
    const patterns = group.patterns.map(p => p.startsWith('!') ? '!' + prefix + p.slice(1) : prefix + p)
    const folders = await globby(patterns, {
      cwd: root,
      onlyDirectories: true,
      expandDirectories: false,
      followSymbolicLinks: false,
      ignore: ['**/node_modules/**', '**/.git/**', '**/.yarn/**'],
    })
    queue.push(...folders.sort().map(p => '/' + p.replace(/\/$/, '')))
  }
  return tree
}

import { resolve } from 'node:path'
import { Adapter, assertPortable, assertRegistrySpecifier, copyOptional, exists, major, UnsupportedError, writeManifests } from './shared.ts'

function assertOverrides(overrides: unknown, label: string) {
  if (typeof overrides === 'string') {
    // `$name` refers to the specifier of a direct dependency.
    if (!overrides.startsWith('$')) assertRegistrySpecifier(overrides, label)
    return
  }
  for (const value of Object.values(overrides || {})) assertOverrides(value, label)
}

/** Name of the package installed at a `node_modules` location. */
function installedName(location: string) {
  return location.slice(location.lastIndexOf('node_modules/') + 13)
}

function isPortable(entry: any) {
  return !entry.resolved || /^https?:/.test(entry.resolved)
}

/**
 * Map the root lockfile into the repository: entries below the repository directory are
 * moved to the corresponding location, hoisted registry entries keep their location, and
 * entries of other workspaces are dropped. A previous repository lockfile only contributes
 * packages that the root lockfile does not contain.
 */
export function seedNpm(root: string, previous: string | undefined, prefix: string, projects: string[]) {
  const workspaces = new Set(projects)
  const remap = (location: string) => location === prefix ? '' : location.startsWith(prefix + '/') ? location.slice(prefix.length + 1) : undefined
  // A location inside the repository belongs to a staged workspace or to the `node_modules` of one.
  const staged = (location: string) => {
    const index = location.indexOf('node_modules/')
    return workspaces.has(index < 0 ? location : location.slice(0, Math.max(0, index - 1)))
  }
  const hoisted: Record<string, any> = {}
  const local: Record<string, any> = {}
  for (const [location, entry] of Object.entries<any>(JSON.parse(root).packages || {})) {
    if (!location) continue
    if (entry.link) {
      // Links to the repository root or to other repositories do not exist in a standalone checkout.
      const target = remap(entry.resolved)
      if (target && workspaces.has(target)) hoisted[location] = { ...entry, resolved: target }
    } else if (location.startsWith('node_modules/')) {
      if (isPortable(entry)) hoisted[location] = entry
    } else {
      const target = remap(location)
      if (target !== undefined && staged(target) && isPortable(entry)) local[target] = entry
    }
  }
  // Placements inside the repository take precedence over hoisted placements of the outer root.
  const packages = { ...hoisted, ...local }
  if (previous) {
    const names = new Set(Object.keys(packages).filter(location => location.includes('node_modules/')).map(installedName))
    for (const [location, entry] of Object.entries<any>(JSON.parse(previous).packages || {})) {
      if (!location || location in packages || !isPortable(entry)) continue
      if (entry.link ? !workspaces.has(entry.resolved) : !location.startsWith('node_modules/') && !staged(location)) continue
      if (location.includes('node_modules/') && names.has(installedName(location))) continue
      packages[location] = entry
    }
  }
  return JSON.stringify({ lockfileVersion: 3, requires: true, packages }, null, 2) + '\n'
}

export const npm: Adapter = {
  filename: 'package-lock.json',
  versions: 'npm 9 or later',
  supports: version => major(version) >= 9,
  discover: {},
  async stage(tree, directory) {
    if (await exists(resolve(tree.root, 'npm-shrinkwrap.json'))) {
      throw new UnsupportedError(`${tree.root}: npm-shrinkwrap.json is not supported`)
    }
    assertPortable(tree)
    assertOverrides((tree.packages[''] as any).overrides, `${tree.root}: overrides`)
    await writeManifests(tree, directory)
    await copyOptional(resolve(tree.root, '.npmrc'), resolve(directory, '.npmrc'))
  },
  seed: seedNpm,
  args: ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
  verify(content) {
    const { lockfileVersion } = JSON.parse(content)
    if (lockfileVersion !== 3) throw new Error(`npm wrote lockfileVersion ${lockfileVersion}; expected 3`)
  },
}

import { writeFile } from 'fs/promises'
import { gt, SemVer } from 'semver'
import { cyan, green } from 'kleur'
import { confirm, register, cwd, PackageJson, Project } from 'yakumo'

const bumpTypes = ['major', 'minor', 'patch', 'prerelease', 'version', 'reset'] as const
type BumpType = typeof bumpTypes[number]

class Package {
  meta: PackageJson
  version: string
  dirty: boolean

  constructor(public path: string) {
    this.meta = require(`${cwd}/${path}/package.json`)
    this.version = this.meta.version
  }

  bump(flag: BumpType, options: any) {
    if (this.meta.private) return
    let version = new SemVer(this.meta.version)
    const reset = flag === 'reset'
    if (!flag || reset) {
      if (version.prerelease.length) {
        const prerelease = version.prerelease.slice() as [string, number]
        prerelease[1] += reset ? -1 : 1
        version.prerelease = prerelease
      } else {
        version.patch += reset ? -1 : 1
      }
      if (reset) {
        this.dirty = true
        return this.version = version.format()
      }
    } else if (flag === 'version') {
      this.dirty = true
      this.version = options.version
      return options.version
    } else if (flag === 'prerelease') {
      if (version.prerelease.length) {
        version.prerelease = [{
          alpha: 'beta',
          beta: 'rc',
        }[version.prerelease[0]], 0]
      } else {
        version = new SemVer(`${version.major + 1}.0.0-alpha.0`)
      }
    } else {
      if (version.prerelease.length) {
        version.prerelease = []
      } else {
        version[flag] += 1
        if (flag !== 'patch') version.patch = 0
        if (flag === 'major') version.minor = 0
      }
    }
    const formatted = version.format()
    if (gt(formatted, this.version)) {
      this.dirty = true
      this.version = formatted
      return formatted
    }
  }

  save(indent: string) {
    this.meta.version = this.version
    const content = JSON.stringify(this.meta, null, indent) + '\n'
    return writeFile(`${cwd}/${this.path}/package.json`, content)
  }
}

class Graph {
  nodes: Record<string, Package> = {}

  constructor(public project: Project) {
    for (const path in project.workspaces) {
      this.nodes[path] = new Package(path)
    }
  }

  each<T>(callback: (node: Package, path: string) => T) {
    const results: T[] = []
    for (const path in this.nodes) {
      results.push(callback(this.nodes[path], path))
    }
    return results
  }

  bump(node: Package, flag: BumpType) {
    const version = node.bump(flag, this.project.argv)
    if (!version) return
    const dependents = new Set<Package>()
    this.each((target) => {
      const { name } = node.meta
      if (target.meta.name === name) return
      const npmLinkPrefix = `npm:${name}@`
      for (const type of ['devDependencies', 'peerDependencies', 'dependencies', 'optionalDependencies'] as const) {
        const deps = target.meta[type] || {}
        for (const key in deps) {
          const value = deps[key]
          if (key === name) {
            update('')
          } else if (value.startsWith(npmLinkPrefix)) {
            update(npmLinkPrefix)
          }

          function update(prefix: string) {
            const range = value.slice(prefix.length)
            if (range.includes(':')) return
            const modifier = /^[\^~]?/.exec(range)[0]
            if (range === modifier + version) return
            target.meta[type][key] = prefix + modifier + version
            target.dirty = true
            if (type !== 'devDependencies') {
              dependents.add(target)
            }
          }
        }
      }
    })
    if (!this.project.argv.recursive) return
    dependents.forEach(dep => this.bump(dep, flag))
  }

  async save() {
    await Promise.all(this.each((node) => {
      if (!node.dirty) return
      if (node.version === node.meta.version) {
        console.log(`- ${node.meta.name}: dependency updated`)
      } else {
        console.log(`- ${node.meta.name}: ${cyan(node.meta.version)} => ${green(node.version)}`)
      }
      return node.save(this.project.indent)
    }))
  }
}

register('version', async (project) => {
  if (!project.argv._.length) {
    const yes = await confirm('You did not specify any packages to bump. Do you want to bump all the packages?')
    if (!yes) return
  }

  const flag = (() => {
    for (const type of bumpTypes) {
      if (type in project.argv) return type
    }
  })()

  if (flag === 'version') {
    // ensure valid version
    new SemVer(project.argv.version)
  }

  const graph = new Graph(project)
  for (const path in project.targets) {
    graph.bump(graph.nodes[path], flag)
  }

  await graph.save()
}, {
  alias: {
    major: ['1'],
    minor: ['2'],
    patch: ['3'],
    reset: ['0'],
    prerelease: ['p'],
    version: ['v'],
    recursive: ['r'],
  },
  boolean: ['major', 'minor', 'patch', 'reset', 'prerelease', 'recursive'],
})

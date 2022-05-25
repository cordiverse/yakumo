import { writeFile } from 'fs-extra'
import { gt, SemVer } from 'semver'
import { cyan, green } from 'kleur'
import { register, cwd, PackageJson, Project } from 'yakumo'

const bumpTypes = ['major', 'minor', 'patch', 'prerelease', 'version'] as const
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
    if (!flag) {
      if (version.prerelease.length) {
        const prerelease = version.prerelease.slice() as [string, number]
        prerelease[1] += 1
        version.prerelease = prerelease
      } else {
        version.patch += 1
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

  save() {
    this.meta.version = this.version
    return writeFile(`${cwd}/${this.path}/package.json`, JSON.stringify(this.meta, null, 2))
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
      const { devDependencies, peerDependencies, dependencies, optionalDependencies } = target.meta
      const { name } = node.meta
      if (target.meta.name === name) return
      Object.entries({ devDependencies, peerDependencies, dependencies, optionalDependencies })
        .filter(([, dependencies = {}]) => dependencies[name])
        .forEach(([type]) => {
          const old = target.meta[type][name]
          const prefix = /^[\^~]?/.exec(old)[0]
          if (old === prefix + version) return
          target.meta[type][name] = prefix + version
          target.dirty = true
          if (type !== 'devDependencies') {
            dependents.add(target)
          }
        })
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
      return node.save()
    }))
  }
}

register('version', async (project) => {
  const graph = new Graph(project)

  const flag = (() => {
    for (const type of bumpTypes) {
      if (type in project.argv) return type
    }
  })()

  for (const path in project.targets) {
    graph.bump(graph.nodes[path], flag)
  }

  await graph.save()
}, {
  alias: {
    major: ['1'],
    minor: ['2'],
    patch: ['3'],
    prerelease: ['p'],
    version: ['v'],
    recursive: ['r'],
  },
  boolean: ['major', 'minor', 'patch', 'prerelease', 'recursive'],
})

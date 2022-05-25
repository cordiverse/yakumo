import { DependencyType, register, PackageJson } from 'yakumo'
import { cyan, green, yellow } from 'kleur'
import { gt } from 'semver'
import spawn from 'cross-spawn'
import latest from 'latest-version'
import pMap from 'p-map'
import ora from 'ora'

interface UpgradeConfig {
  concurrency?: number
}

declare module 'yakumo' {
  interface PackageJson {
    $dirty?: boolean
  }

  interface Commands {
    upgrade: UpgradeConfig
  }
}

register('upgrade', async (project) => {
  const { targets, manager, config } = project
  const { concurrency = 10 } = config.commands.upgrade || {}
  const deps: Record<string, Record<string, DependencyType[]>> = {}
  for (const path in targets) {
    load(path, targets[path])
  }

  const output: string[] = []
  const requests = Object.keys(deps)
  const names = Object.values(targets).map(p => p.name)
  const spinner = ora(`progress: 0/${requests.length}`).start()
  let progress = 0
  await pMap(requests, async (request) => {
    const [dep, oldRange] = request.split(':')
    if (names.includes(dep)) return
    const oldVersion = oldRange.slice(1)
    const newVersion = await latest(dep, { version: oldRange })
    progress++
    spinner.text = `progress: ${progress}/${requests.length}`
    if (!gt(newVersion, oldVersion)) return
    const newRange = oldRange[0] + newVersion
    output.push(`- ${yellow(dep)}: ${cyan(oldVersion)} -> ${green(newVersion)}`)
    for (const name in deps[request]) {
      Object.defineProperty(targets[name], '$dirty', { value: true })
      for (const type of deps[request][name]) {
        targets[name][type][dep] = newRange
      }
    }
  }, { concurrency })
  spinner.succeed()

  for (const path in targets) {
    if (!targets[path].$dirty) continue
    await project.save(path)
  }

  console.log(output.sort().join('\n'))

  const agent = manager?.name || 'npm'
  const args: string[] = agent === 'yarn' ? [] : ['install']
  spawn.sync(agent, args, { stdio: 'inherit' })

  function load(path: string, meta: PackageJson) {
    delete deps[meta.name]
    for (const type of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      for (const dep in meta[type] || {}) {
        // skip workspaces and symlinks
        const version = meta[type][dep]
        if (targets[dep] || !'^~'.includes(version[0])) continue
        const request = dep + ':' + version
        ;((deps[request] ||= {})[path] ||= []).push(type)
      }
    }
  }
}, {
  manual: true,
})

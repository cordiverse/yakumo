import { register, exit, spawnAsync, addHook } from 'yakumo'
import { gt, prerelease } from 'semver'
import { existsSync } from 'fs'
import { copyFile, rm } from 'fs/promises'
import latest from 'latest-version'
import ora from 'ora'
import prompts from 'prompts'
import { dirname } from 'path'

declare module 'yakumo' {
  interface PackageJson {
    $copied?: boolean
  }

  interface Hooks {
    'publish.before'(this: Project, path: string, meta: PackageJson): Promise<void>
    'publish.after'(this: Project, path: string, meta: PackageJson): Promise<void>
  }
}

function getVersion(name: string, isNext = false) {
  if (isNext) {
    return latest(name, { version: 'next' }).catch(() => getVersion(name))
  } else {
    return latest(name).catch(() => '0.0.1')
  }
}

function isNext(version: string) {
  const parts = prerelease(version)
  if (!parts) return false
  return parts[0] !== 'rc'
}

function publish(agent: string, path: string, name: string, version: string, tag: string) {
  console.log(`publishing ${name}@${version} ...`)
  return spawnAsync([
    agent, 'publish', path.slice(1),
    '--tag', tag,
    '--access', 'public',
  ])
}

register('publish', async (project) => {
  const { argv, targets } = project
  const spinner = ora()
  if (argv._.length) {
    const pending = Object.keys(targets).filter(path => targets[path].private)
    if (pending.length) {
      const paths = pending.map(path => targets[path].name).join(', ')
      const { value } = await prompts({
        name: 'value',
        type: 'confirm',
        message: `workspace ${paths} ${pending.length > 1 ? 'are' : 'is'} private, switch to public?`,
      })
      if (!value) exit('operation cancelled.')

      await Promise.all(pending.map(async (path) => {
        delete targets[path].private
        await project.save(path)
      }))
    }
  } else {
    const entries = Object.entries(project.targets)
    let progress = 0
    spinner.start(`Loading workspaces (0/${entries.length})`)
    await Promise.all(entries.map(async ([path, meta]) => {
      spinner.text = `Loading workspaces (${++progress}/${entries.length})`
      if (!meta.private) {
        const version = await getVersion(meta.name, isNext(meta.version))
        if (gt(meta.version, version)) return
      }
      delete targets[path]
    }))
    spinner.succeed()
  }

  const agent = project.manager?.name || 'npm'
  for (const path in targets) {
    const { name, version } = targets[path]
    await project.emit('publish.before', path, targets[path])
    await publish(agent, path, name, version, isNext(version) ? 'next' : 'latest')
    await project.emit('publish.after', path, targets[path])
  }

  spinner.succeed('All workspaces are up to date.')
})

addHook('publish.before', async function (path, target) {
  const initial = path
  while (path.length > 1) {
    if (this.workspaces[path] && existsSync(this.cwd + path + '/readme.md')) {
      if (path === initial) return
      Object.defineProperty(target, '$copied', { value: true })
      await copyFile(`${this.cwd}${path}/README.md`, `${this.cwd}${initial}/README.md`)
      return
    }
    path = dirname(path)
  }
})

addHook('publish.after', async function (path, target) {
  if (target.$copied) {
    await rm(`${this.cwd}${path}/README.md`)
  }
})

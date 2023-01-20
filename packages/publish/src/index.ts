import { register, Manager, exit, spawnAsync } from 'yakumo'
import { gt, prerelease } from 'semver'
import { Awaitable } from 'cosmokit'
import latest from 'latest-version'
import ora from 'ora'
import prompts from 'prompts'

declare module 'yakumo' {
  interface PackageJson {
    $copied?: boolean
  }

  interface Hooks {
    'publish.before'(this: Project, path: string, meta: PackageJson): Awaitable<void>
    'publish.after'(this: Project, path: string, meta: PackageJson): Awaitable<void>
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

function getPublishCommand(manager: Manager) {
  if (!manager) return ['npm']
  if (manager.name !== 'yarn' || manager.version.startsWith('1.')) return [manager.name]
  return ['yarn', 'npm']
}

async function publish(manager: Manager, path: string, name: string, version: string, tag: string, access: string, registry: string, otp: string) {
  // console.log(`publishing ${name}@${version} ...`)
  const args = [
    ...getPublishCommand(manager),
    'publish', path.slice(1),
    '--tag', tag,
    '--access', access,
    '--color',
  ]
  if (registry) args.push('--registry', registry)
  if (otp) args.push('--otp', otp)
  await spawnAsync(args, {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
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

  const total = Object.keys(targets).length
  spinner.start(`Publishing packages (0/${total})`)

  let completed = 0
  await Promise.all(Object.entries(targets).map(async ([path, { name, version }]) => {
    try {
      await project.emit('publish.before', path, targets[path])
      await publish(project.manager, path, name, version, argv.tag ?? (isNext(version) ? 'next' : 'latest'), argv.access ?? 'public', argv.registry, argv.otp)
      await project.emit('publish.after', path, targets[path])
    } finally {
      spinner.text = `Publishing packages (${++completed}/${total})`
    }
  }))

  spinner.succeed('All workspaces are up to date.')
})

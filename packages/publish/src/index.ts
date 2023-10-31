import { cwd, exit, Manager, PackageJson, register, spawnAsync } from 'yakumo'
import { gt, prerelease } from 'semver'
import { Awaitable } from 'cosmokit'
import { join } from 'path'
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

function getPublishCommand(manager: Manager, path: string, meta: PackageJson) {
  if (!manager) return ['npm', 'publish', join(cwd, path), '--color']
  if (manager.name !== 'yarn' || manager.version.startsWith('1.')) return [manager.name, 'publish', join(cwd, path), '--color']
  return ['yarn', 'workspace', meta.name, 'npm', 'publish']
}

async function publish(manager: Manager, path: string, meta: PackageJson, args: string[]) {
  // console.log(`publishing ${name}@${version} ...`)
  args = [
    ...getPublishCommand(manager, path, meta),
    ...args,
  ]
  return await spawnAsync(args, {
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

  let completed = 0, failed = 0
  await Promise.all(Object.entries(targets).map(async ([path, meta]) => {
    try {
      await project.emit('publish.before', path, targets[path])
      const args = [
        '--tag', argv.tag ?? (isNext(meta.version) ? 'next' : 'latest'),
        '--access', argv.access ?? 'public',
      ]
      if (argv.registry) args.push('--registry', argv.registry)
      if (argv.otp) args.push('--otp', argv.otp)
      const code = await publish(project.manager, path, meta, args)
      if (code) {
        failed++
        return
      }
      await project.emit('publish.after', path, targets[path])
    } finally {
      spinner.text = `Publishing packages (${++completed}/${total})`
    }
  }))

  if (failed) {
    spinner.fail(`Published ${total - failed} packages, ${failed} failed.`)
  } else {
    spinner.succeed(`Published ${total} packages.`)
  }
})

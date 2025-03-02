import { Context } from 'cordis'
import { manager, spawnAsync } from '../index.js'

export const inject = ['yakumo']

export function apply(ctx: Context) {
  ctx.register('run', async () => {
    const { argv, cwd } = ctx.yakumo
    const [command, ...rest] = argv['--'] as string[]
    if (!command) throw new Error('Missing command')
    const paths = ctx.yakumo.locate(argv._, {
      filter: () => true,
    }).filter(path => {
      return !!ctx.yakumo.workspaces[path].scripts?.[command]
    })
    for (const path of paths) {
      const agent = manager?.name || 'npm'
      await spawnAsync([agent, 'run', command, ...rest], { cwd: cwd + path })
    }
  })
}

import { Context } from 'cordis'
import { manager, spawnAsync } from '../index.js'

export const inject = ['yakumo', 'cli']

export function apply(ctx: Context) {
  ctx.cli
    .command('yakumo.run [...packages]', 'Run scripts in packages')
    .action(async ({ args, options }) => {
      await ctx.yakumo.initialize()
      const { cwd } = ctx.yakumo
      const [command, ...rest] = options['--'] as string[]
      if (!command) throw new Error('Missing command')
      const paths = ctx.yakumo.locate(args, {
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

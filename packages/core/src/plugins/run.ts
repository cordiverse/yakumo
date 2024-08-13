import { Context, manager, spawnAsync } from '../index.js'

export const inject = ['yakumo']

export function apply(ctx: Context) {
  ctx.register('run', async () => {
    const { argv, cwd } = ctx.yakumo
    const index = argv._.indexOf('--')
    if (index === -1 || index === argv._.length - 1) {
      throw new Error('Missing command')
    }
    const [, command, ...rest] = argv._.splice(index)
    const paths = ctx.yakumo.locate(argv._, {
      filter: (meta) => !!meta.scripts?.[command],
    })
    for (const path of paths) {
      const agent = manager?.name || 'npm'
      await spawnAsync([agent, 'run', command, ...rest], { cwd: cwd + path })
    }
  })
}

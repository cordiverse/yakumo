import { Context } from 'yakumo'
import { load } from 'tsconfig-utils'
import dumble from 'dumble'

export const inject = ['yakumo']

export function apply(ctx: Context) {
  ctx.register('esbuild', async () => {
    const paths = ctx.yakumo.locate(ctx.yakumo.argv._)
    await Promise.all(paths.map(async (path) => {
      const cwd = ctx.yakumo.cwd + path
      const tsconfig = await load(cwd).catch(() => null)
      if (!tsconfig) return
      await dumble(cwd, ctx.yakumo.workspaces[path], tsconfig)
    }))
  })
}

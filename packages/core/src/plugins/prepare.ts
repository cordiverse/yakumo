import { Context } from '..'
import picomatch from 'picomatch'

export default function apply(ctx: Context) {
  ctx.register('prepare', async () => {
    const { workspaces } = ctx.yakumo.workspaces['']
    const current = new Set(workspaces)
    if (!current.size) return
    const match = picomatch(workspaces)
    let hasUpdate = false
    for (const prefix in ctx.yakumo.workspaces) {
      if (!prefix) continue
      const { workspaces = [] } = ctx.yakumo.workspaces[prefix]
      for (const path of workspaces) {
        const result = prefix.slice(1) + '/' + path
        if (match(result)) continue
        console.log(`[I] workspace added: ${result}`)
        current.add(result)
        hasUpdate = true
      }
      for (const path of current) {
        if (!path.startsWith(prefix.slice(1) + '/')) continue
        if (workspaces.includes(path.slice(prefix.length))) continue
        if (ctx.yakumo.argv.clean) {
          console.log(`[W] workspace removed: ${path}`)
          current.delete(path)
          hasUpdate = true
        } else {
          console.log(`[W] workspace mismatch: ${path}`)
        }
      }
    }
    if (hasUpdate) {
      ctx.yakumo.workspaces[''].workspaces = [...current].sort()
      await ctx.yakumo.save('')
      await ctx.yakumo.install()
    }
  }, {
    alias: {
      clean: ['c'],
    },
  })
}

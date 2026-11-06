import { Context } from 'cordis'
import picomatch from 'picomatch'

export const inject = ['yakumo', 'cli']

function matcher(patterns: string[]) {
  const positive = picomatch(patterns.filter(p => !p.startsWith('!')))
  const negative = patterns.filter(p => p.startsWith('!')).map(p => picomatch(p.slice(1)))
  return (path: string) => positive(path) && !negative.some(match => match(path))
}

export function apply(ctx: Context) {
  ctx.cli
    .command('prepare [...packages]', 'Prepare workspace configuration')
    .option('-c, --clean', 'Clean removed workspaces')
    .action(async ({ options }) => {
      await ctx.yakumo.initialize()
      const { groups } = ctx.yakumo.workspaceTree
      const patterns = groups['']?.patterns || []
      const current = new Set(patterns)
      if (!current.size) return
      const match = matcher(patterns)
      let hasUpdate = false
      for (const prefix in groups) {
        if (!prefix) continue
        const base = prefix.slice(1) + '/'
        const nested = groups[prefix].patterns
        for (const path of nested) {
          const negated = path.startsWith('!')
          const result = negated ? '!' + base + path.slice(1) : base + path
          if (negated ? current.has(result) : match(result)) continue
          console.log(`[I] workspace added: ${result}`)
          current.add(result)
          hasUpdate = true
        }
        for (const path of current) {
          const negated = path.startsWith('!')
          const target = negated ? path.slice(1) : path
          if (!target.startsWith(base)) continue
          if (nested.includes((negated ? '!' : '') + target.slice(base.length))) continue
          if (options.clean) {
            console.log(`[W] workspace removed: ${path}`)
            current.delete(path)
            hasUpdate = true
          } else {
            console.log(`[W] workspace mismatch: ${path}`)
          }
        }
      }
      if (hasUpdate) {
        await ctx.yakumo.saveWorkspaces([...current].sort())
        await ctx.yakumo.install()
      }
    })
}

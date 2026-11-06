import { Context } from 'cordis'
import picomatch from 'picomatch'
import { globby } from 'globby'
import { normalizePatterns } from '../workspace.ts'

export const inject = ['yakumo', 'cli']

export function apply(ctx: Context) {
  ctx.cli
    .command('prepare [...packages]', 'Prepare workspace configuration')
    .option('-c, --clean', 'Clean removed workspaces')
    .action(async ({ options }) => {
      await ctx.yakumo.initialize()
      const { groups } = ctx.yakumo.workspaceTree
      const npm = ctx.yakumo.manager.name === 'npm'
      if (!groups['']?.patterns.length) return
      // Remove the order dependence of exclusions, so that merged patterns can be sorted.
      const patterns = normalizePatterns(groups[''].patterns, npm)
      const current = new Set(patterns)
      const prefixes = Object.keys(groups).filter(Boolean)
      // Patterns of nested groups, relative to the root.
      const scoped = prefixes.map((prefix) => {
        const base = prefix.slice(1) + '/'
        return normalizePatterns(groups[prefix].patterns, npm).map(path => path.startsWith('!') ? '!' + base + path.slice(1) : base + path)
      })
      const declared = scoped.flat()
      const added = scoped.map(() => [] as string[])
      scoped.forEach((own, index) => {
        for (const path of own) {
          // A pattern of the root does not prove that it includes the directories of another
          // pattern, so only equal patterns are omitted. The root can exclude a nested pattern
          // explicitly; exclusions of the root apply to added patterns as well.
          if (path.startsWith('!') || current.has(path) || current.has('!' + path)) continue
          console.log(`[I] workspace added: ${path}`)
          current.add(path)
          added[index].push(path)
        }
      })
      // A nested exclusion applies only to its own group, but the root applies exclusions to
      // all of its patterns. An exclusion is therefore added only if it removes no existing
      // workspace and no directory that another group adds.
      for (const [index, own] of scoped.entries()) {
        const others = picomatch(added.flatMap((paths, i) => i === index ? [] : paths))
        for (const path of own) {
          if (!path.startsWith('!') || current.has(path)) continue
          const directories = await globby(path.slice(1), {
            cwd: ctx.yakumo.cwd,
            onlyDirectories: true,
            expandDirectories: false,
            followSymbolicLinks: false,
            ignore: ['**/node_modules/**', '**/.git/**'],
          })
          const conflicts = directories.filter(directory => ctx.yakumo.workspaces['/' + directory] || others(directory))
          if (conflicts.length) {
            console.log(`[W] workspace exclusion skipped: ${path} (includes ${conflicts.join(', ')})`)
            continue
          }
          console.log(`[I] workspace added: ${path}`)
          current.add(path)
        }
      }
      for (const path of current) {
        // Exclusions of the root are kept; an exclusion of a removed directory has no effect.
        if (path.startsWith('!') || declared.includes(path)) continue
        if (!prefixes.some(prefix => path.startsWith(prefix.slice(1) + '/'))) continue
        if (options.clean) {
          console.log(`[W] workspace removed: ${path}`)
          current.delete(path)
        } else {
          console.log(`[W] workspace mismatch: ${path}`)
        }
      }
      // Exclusions come last, so that npm applies them to every pattern.
      const result = [...current].sort((a, b) => Number(a.startsWith('!')) - Number(b.startsWith('!')) || (a < b ? -1 : a > b ? 1 : 0))
      if (result.length !== new Set(patterns).size || result.some(path => !patterns.includes(path))) {
        await ctx.yakumo.saveWorkspaces(result)
        await ctx.yakumo.install()
      }
    })
}

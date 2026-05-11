import { Context } from 'yakumo'
import type {} from '@cordisjs/plugin-cli'
import { startVitest, Vitest } from 'vitest/node'
import { defaultExclude } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { globby } from 'globby'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const inject = ['yakumo', 'cli']

const EXCLUDE = [...defaultExclude, '**/.claude/**']

const CONFIG_NAMES = [
  'vitest.config.ts', 'vitest.config.js',
  'vitest.config.mts', 'vitest.config.mjs',
  'vitest.config.cts', 'vitest.config.cjs',
]

// Walk upward from `file` until we find a vitest.config.*, stopping at `floor`.
// Returns the config's containing dir, or `floor` if none found.
function findConfigRoot(file: string, floor: string): string {
  let dir = dirname(file)
  while (dir.length >= floor.length) {
    for (const name of CONFIG_NAMES) {
      if (existsSync(resolve(dir, name))) return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return floor
}

export function apply(ctx: Context) {
  ctx.cli
    .command('vitest [...packages]', 'Run tests with vitest')
    .option('-w, --watch', 'Watch mode')
    .option('-u, --update', 'Update snapshots')
    .option('-b, --bail [bail:integer]', 'Stop after first N failures')
    .option('-t, --test-timeout [ms:integer]', 'Per-test timeout in milliseconds')
    .option('--coverage', 'Collect coverage (requires @vitest/coverage-v8)')
    .option('--coverage.reporter [...reporter]', 'Coverage reporter(s): text, html, json, lcov, ...')
    .action(async ({ args, options }) => {
      await ctx.yakumo.initialize()

      function getPatterns(names: string[]) {
        if (!names.length) return ['**/tests/*.spec.ts']
        return names.flatMap((name) => {
          const [folder] = name.split('/', 1)
          name = name.slice(folder.length + 1) || '*'
          return ctx.yakumo.locate(folder, { includeRoot: true }).map((path) => {
            return `${path}/tests/${name}.spec.ts`.slice(1)
          })
        })
      }

      const files = await globby(getPatterns(args), {
        cwd: ctx.yakumo.cwd,
        onlyFiles: true,
        absolute: true,
        ignore: EXCLUDE,
      })

      // Group spec files by the nearest ancestor vitest.config.*. Each group
      // runs as an independent vitest invocation rooted at its config dir, so
      // per-project plugins / resolve.alias / setupFiles are honoured. Files
      // with no config above them fall into the yakumo-cwd group (which in
      // turn uses vitest defaults).
      const groups = new Map<string, string[]>()
      for (const file of files) {
        const root = findConfigRoot(file, ctx.yakumo.cwd)
        if (!groups.has(root)) groups.set(root, [])
        groups.get(root)!.push(file)
      }

      const watched: Vitest[] = []
      let totalFailed = 0
      for (const [root, files] of groups) {
        const testTsConfig = resolve(root, 'tsconfig.test.json')
        const vitest = await startVitest('test', files, {
          watch: !!options.watch,
          update: !!options.update,
          bail: options.bail,
          testTimeout: options.testTimeout,
          passWithNoTests: true,
          root,
          exclude: EXCLUDE,
          ...options.coverage ? {
            coverage: {
              enabled: true,
              provider: 'v8',
              reporter: options['coverage.reporter'],
            },
          } : {},
        }, {
          plugins: [tsconfigPaths(existsSync(testTsConfig) ? { projects: [testTsConfig] } : {})],
        })

        if (!vitest) {
          process.exit(1)
        }

        if (options.watch) {
          watched.push(vitest)
          continue
        }

        totalFailed += vitest.state.getCountOfFailedTests()
        totalFailed += vitest.state.getUnhandledErrors().length
        await vitest.close()
      }

      if (watched.length) return
      process.exit(totalFailed > 0 ? 1 : 0)
    })
}

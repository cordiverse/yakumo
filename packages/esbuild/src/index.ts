import { build, BuildFailure, BuildOptions, Message, Plugin } from 'esbuild'
import { cyan, red, yellow } from 'kleur'
import { register, PackageJson, Project } from 'yakumo'
import { load } from 'tsconfig-utils'
import path from 'path'

declare module 'yakumo' {
  interface Hooks {
    'esbuild.before'(options: BuildOptions, meta: PackageJson): void
    'esbuild.after'(options: BuildOptions, meta: PackageJson): void
  }
}

const ignored = [
  'This call to "require" will not be bundled because the argument is not a string literal',
  'Indirect calls to "require" will not be bundled',
  'should be marked as external for use with "require.resolve"',
]

function display(prefix: string) {
  return ({ location, text }: Message) => {
    if (ignored.some(message => text.includes(message))) return
    if (!location) return console.log(prefix, text)
    const { file, line, column } = location
    console.log(cyan(`${file}:${line}:${column}:`), prefix, text)
  }
}

const displayError = display(red('error:'))
const displayWarning = display(yellow('warning:'))

let code = 0

function bundle(options: BuildOptions) {
  // show entry list
  for (const [key, value] of Object.entries(options.entryPoints)) {
    const source = path.relative(process.cwd(), value)
    const target = path.relative(process.cwd(), path.resolve(options.outdir, key + options.outExtension['.js']))
    console.log('esbuild:', source, '->', target)
  }

  return build(options).then(({ warnings }) => {
    warnings.forEach(displayWarning)
  }, ({ warnings, errors }: BuildFailure) => {
    errors.forEach(displayError)
    warnings.forEach(displayWarning)
    if (errors.length) code = 1
  })
}

async function compile(relpath: string, meta: PackageJson, project: Project) {
  // filter out private packages
  if (meta.private) return []

  const filter = /^[@/\w-]+$/
  const entryPoints = new Set<string>()
  const externalPlugin: Plugin = {
    name: 'external library',
    setup(build) {
      const currentEntry = Object.values(build.initialOptions.entryPoints)[0]
      build.onResolve({ filter }, () => ({ external: true }))
      build.onResolve({ filter: /^\./, namespace: 'file' }, async (args) => {
        const { path } = await build.resolve(args.path, {
          namespace: 'internal',
          importer: args.importer,
          resolveDir: args.resolveDir,
          kind: args.kind,
        })
        if (currentEntry === path || !entryPoints.has(path)) return null
        return { external: true }
      })
    },
  }

  const base = project.cwd + relpath
  const config = await load(base)
  const { rootDir, noEmit, emitDeclarationOnly } = config.compilerOptions
  if (!noEmit && !emitDeclarationOnly) return []

  const matrix: BuildOptions[] = []

  function addBuild(name: string, options: BuildOptions) {
    if (!name) return
    let [outDir] = name.split('/', 1)
    let entry = name.slice(outDir.length + 1)
    if (!entry) [outDir, entry] = [entry, outDir]
    const extname = path.extname(entry)
    const basename = entry.slice(0, -extname.length)
    const filename = path.join(base, rootDir, basename + '.ts')
    entryPoints.add(filename)
    matrix.push({
      outdir: path.join(base, outDir),
      outbase: path.join(base, rootDir),
      outExtension: { '.js': extname },
      entryPoints: { [basename]: filename },
      bundle: true,
      sourcemap: true,
      keepNames: true,
      charset: 'utf8',
      logLevel: 'silent',
      plugins: [externalPlugin],
      resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.css', '.json'],
      ...options,
    })
  }

  const nodeOptions: BuildOptions = {
    platform: 'node',
    target: 'node12',
    format: 'cjs',
  }

  const browserOptions: BuildOptions = {
    platform: 'browser',
    target: 'esnext',
    format: 'esm',
  }

  addBuild(meta.main, nodeOptions)
  addBuild(meta.module, browserOptions)

  if (typeof meta.bin === 'string') {
    addBuild(meta.bin, nodeOptions)
  } else if (meta.bin) {
    for (const key in meta.bin) {
      addBuild(meta.bin[key], nodeOptions)
    }
  }

  return matrix
}

register('esbuild', async (project) => {
  await Promise.all(Object.entries(project.targets).map(async ([key, value]) => {
    const matrix = await compile(key, value, project)
    await Promise.all(matrix.map(async (options) => {
      await project.emit('esbuild.before', options, value)
      await bundle(options)
      await project.emit('esbuild.after', options, value)
    })).catch(console.error)
  }))
  process.exit(code)
})

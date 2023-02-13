import { build, BuildFailure, BuildOptions, Message, Plugin } from 'esbuild'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'path'
import { cyan, red, yellow } from 'kleur'
import { register, PackageJson, Project } from 'yakumo'
import { load } from 'tsconfig-utils'
import { Dict } from 'cosmokit'
import globby from 'globby'

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
    const source = relative(process.cwd(), value)
    const target = relative(process.cwd(), resolve(options.outdir, key + options.outExtension['.js']))
    console.log('esbuild:', source, '->', target)
  }

  return build(options).then(({ warnings }) => {
    warnings.forEach(displayWarning)
  }, ({ warnings, errors }: BuildFailure) => {
    errors.forEach(displayError)
    warnings.forEach(displayWarning)
    code += errors.length
  })
}

async function compile(relpath: string, meta: PackageJson, project: Project) {
  // filter out private packages
  if (meta.private) return []

  const filter = /^[@\w].+$/
  const externalPlugin: Plugin = {
    name: 'external library',
    setup(build) {
      const { entryPoints, platform, format } = build.initialOptions
      const currentEntry = Object.values(entryPoints)[0]
      build.onResolve({ filter }, (args) => {
        if (isAbsolute(args.path)) return null
        return { external: true }
      })
      build.onResolve({ filter: /^\./, namespace: 'file' }, async (args) => {
        const { path } = await build.resolve(args.path, {
          namespace: 'internal',
          importer: args.importer,
          resolveDir: args.resolveDir,
          kind: args.kind,
        })
        if (currentEntry === path || !exports[path]) return null
        if (format === 'cjs') return { external: true }
        // native ESM import should preserve extensions
        const outFile = exports[path][platform] || exports[path].default
        if (!outFile) return null
        const outDir = dirname(exports[currentEntry][platform])
        let relpath = relative(outDir, outFile)
        if (!relpath.startsWith('.')) relpath = './' + relpath
        return { path: relpath, external: true }
      })
    },
  }

  const base = project.cwd + relpath
  const config = await load(base)
  const { rootDir, outFile, outDir = dirname(outFile), noEmit, emitDeclarationOnly } = config.compilerOptions
  if (!noEmit && !emitDeclarationOnly) return []

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

  const outdir = join(base, outDir)
  const outbase = join(base, rootDir)
  const matrix: BuildOptions[] = []
  const exports: Dict<Dict<string>> = Object.create(null)
  const outFiles = new Set<string>()

  function addExport(pattern: string, options: BuildOptions) {
    if (!pattern) return
    if (pattern.startsWith('./')) pattern = pattern.slice(2)
    if (!pattern.startsWith(outDir + '/')) {
      // handle files like `package.json`
      pattern = pattern.replace('*', '**')
      const targets = globby.sync(pattern, { cwd: base })
      for (const target of targets) {
        // ignore exports in `rootDir`
        if (!relative(rootDir, target).startsWith('../')) continue
        const filename = join(base, target)
        exports[filename] = { default: filename }
      }
      return
    }

    // https://nodejs.org/api/packages.html#subpath-patterns
    // `*` maps expose nested subpaths as it is a string replacement syntax only
    const outExt = extname(pattern)
    pattern = pattern.slice(outDir.length + 1, -outExt.length).replace('*', '**') + '.{ts,tsx}'
    const targets = globby.sync(pattern, { cwd: outbase })
    for (const target of targets) {
      const srcFile = join(base, rootDir, target)
      const srcExt = extname(target)
      const entry = target.slice(0, -srcExt.length)
      const outFile = join(outdir, entry + outExt)
      if (outFiles.has(outFile)) return

      outFiles.add(outFile)
      ;(exports[srcFile] ||= {})[options.platform] = outFile
      matrix.push({
        outdir,
        outbase,
        outExtension: { '.js': outExt },
        entryPoints: { [entry]: srcFile },
        bundle: true,
        sourcemap: true,
        keepNames: true,
        charset: 'utf8',
        logLevel: 'silent',
        plugins: [externalPlugin],
        resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.css', '.json'],
        tsconfig: base + '/tsconfig.json',
        ...options,
      })
    }
  }

  // TODO: support null targets
  function addConditionalExport(pattern: PackageJson.Exports, options: BuildOptions) {
    if (typeof pattern === 'string') {
      return addExport(pattern, options)
    }

    for (const key in pattern) {
      if (key === 'node' || key === 'require' || key.startsWith('.')) {
        addConditionalExport(pattern[key], nodeOptions)
      } else {
        addConditionalExport(pattern[key], browserOptions)
      }
    }
  }

  addExport(meta.main, meta.type === 'module' ? browserOptions : nodeOptions)
  addExport(meta.module, browserOptions)
  addConditionalExport(meta.exports, nodeOptions)

  if (!meta.exports) {
    addExport('package.json', nodeOptions)
  }

  if (typeof meta.bin === 'string') {
    addExport(meta.bin, nodeOptions)
  } else if (meta.bin) {
    for (const key in meta.bin) {
      addExport(meta.bin[key], nodeOptions)
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
  if (code) process.exit(code)
})

import { build, BuildFailure, BuildOptions, Message, Plugin } from 'esbuild'
import { resolve, relative } from 'path'
import { cyan, red, yellow } from 'kleur'
import { readFile } from 'fs/promises'
import { register, PackageJson, Project } from 'yakumo'
import ts from 'typescript'
import json5 from 'json5'

declare module 'yakumo' {
  interface Hooks {
    'esbuild.before'(options: BuildOptions[], meta: PackageJson): void
    'esbuild.after'(options: BuildOptions[], meta: PackageJson): void
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

function bundle(options: BuildOptions, index: number) {
  // show entry list
  for (const [key, value] of Object.entries(options.entryPoints)) {
    const source = relative(process.cwd(), value)
    const target = relative(process.cwd(), resolve(options.outdir, key + '.js'))
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

interface Reference {
  path: string
}

export interface TsConfig {
  extends?: string
  files?: string[]
  references?: Reference[]
  compilerOptions?: ts.CompilerOptions
}

async function readTsConfig(base: string) {
  const source = await readFile(base, 'utf8')
  return json5.parse(source) as TsConfig
}

async function parseTsConfig(base: string) {
  const config = await readTsConfig(base)
  while (config.extends) {
    const parent = await readTsConfig(resolve(base, '..', config.extends + '.json'))
    Object.assign(config.compilerOptions, parent.compilerOptions)
    config.extends = parent.extends
  }
  return config
}

async function compile(path: string, meta: PackageJson, project: Project) {
  // filter out private packages
  if (meta.private) return

  const filter = /^[@/\w-]+$/
  const externalPlugin: Plugin = {
    name: 'external library',
    setup(build) {
      build.onResolve({ filter }, () => ({ external: true }))
    },
  }

  const base = project.cwd + path
  const config = await parseTsConfig(base + '/tsconfig.json')
  const { emitDeclarationOnly } = config.compilerOptions
  if (!emitDeclarationOnly) return

  const options: BuildOptions[] = [{
    outdir: base + '/lib',
    entryPoints: {
      [meta.main.slice(4, -3)]: base + '/src/index.ts',
    },
    bundle: true,
    platform: 'node',
    target: 'node12',
    charset: 'utf8',
    logLevel: 'silent',
    sourcemap: true,
    keepNames: true,
    plugins: [externalPlugin],
  }]

  // bundle for both node and browser
  if (meta.module) {
    options.push({
      ...options[0],
      entryPoints: {
        [meta.module.slice(4, -3)]: base + '/src/index.ts',
      },
      format: 'esm',
      target: 'esnext',
      platform: 'browser',
      sourcemap: false,
      minify: true,
    })
  }

  project.emit('esbuild.before', options, meta)
  await Promise.all(options.map(bundle)).catch(console.error)
  project.emit('esbuild.after', options, meta)
}

register('esbuild', async (project) => {
  await Promise.all(Object.entries(project.targets).map(([key, value]) => {
    return compile(key, value, project)
  }))
  process.exit(code)
})

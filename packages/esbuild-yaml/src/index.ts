import { Context } from 'yakumo'
import { Plugin } from 'esbuild'
import {} from 'yakumo-esbuild'
import { load, LoadOptions } from 'js-yaml'
import { promises as fs } from 'fs'

const yamlPlugin = (options: LoadOptions = {}): Plugin => ({
  name: 'yaml',
  setup(build) {
    build.initialOptions.resolveExtensions.push('.yml', '.yaml')

    build.onLoad({ filter: /\.ya?ml$/ }, async ({ path }) => {
      const source = await fs.readFile(path, 'utf8')
      return {
        loader: 'json',
        contents: JSON.stringify(load(source, options)),
      }
    })
  },
})

export function apply(ctx: Context) {
  ctx.on('esbuild/before', (options) => {
    options.plugins.push(yamlPlugin())
  })
}

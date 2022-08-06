import { addHook } from 'yakumo'
import { Plugin } from 'esbuild'
import {} from 'yakumo-esbuild'
import { load, LoadOptions } from 'js-yaml'
import { promises as fsp } from 'fs'

const yamlPlugin = (options: LoadOptions = {}): Plugin => ({
  name: 'yaml',
  setup(build) {
    build.initialOptions.resolveExtensions.push('.yml', '.yaml')

    build.onLoad({ filter: /\.ya?ml$/ }, async ({ path }) => {
      const source = await fsp.readFile(path, 'utf8')
      return {
        loader: 'json',
        contents: JSON.stringify(load(source, options)),
      }
    })
  },
})

addHook('esbuild.before', (options) => {
  options.plugins.push(yamlPlugin())
})

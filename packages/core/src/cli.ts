#!/usr/bin/env node

for (let i = 2; i < process.argv.length; i++) {
  if (!process.argv[i].startsWith('--import')) continue
  const [arg] = process.argv.splice(i, 1)
  let [, path] = arg.split('=')
  if (!path) {
    path = process.argv.splice(i, 1)[0]
  }
  await import(path)
  --i
}

const { Context } = await import('cordis')
const { Loader } = await import('@cordisjs/plugin-loader')

const ctx = new Context()
await ctx.plugin(Loader)

await ctx.loader.create({
  name: '@cordisjs/plugin-include',
  config: {
    path: './yakumo.yml',
    initial: [
      { name: '@cordisjs/plugin-cli', config: { name: 'yakumo' } },
      { name: 'yakumo' },
      { name: 'yakumo/list' },
      { name: 'yakumo/prepare' },
      { name: 'yakumo/publish' },
      { name: 'yakumo/run' },
      { name: 'yakumo/test' },
      { name: 'yakumo/upgrade' },
      { name: 'yakumo/version' },
    ],
  },
})

export {}

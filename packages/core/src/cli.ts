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

await new Context().plugin(Loader, {
  name: 'yakumo',
  initial: [
    { name: '@cordisjs/plugin-cli', config: { name: 'yakumo' } },
    { name: '@cordisjs/plugin-cli-help' },
    { name: 'yakumo' },
    { name: 'yakumo/list' },
    { name: 'yakumo/prepare' },
    { name: 'yakumo/publish' },
    { name: 'yakumo/run' },
    { name: 'yakumo/test' },
    { name: 'yakumo/upgrade' },
    { name: 'yakumo/version' },
  ],
})

export {}

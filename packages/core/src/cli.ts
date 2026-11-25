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
const { default: Fs } = await import('@cordisjs/fs')
const { default: NodeFs } = await import('@cordisjs/fs-node')
const { default: Loader } = await import('@cordisjs/loader')
const { default: Include } = await import('@cordisjs/include')
const { default: Cli } = await import('@cordisjs/cli')

const ctx = new Context()

await ctx.use(Fs)
await ctx.use(NodeFs)
await ctx.use(Loader)
await ctx.use(Include, {
  path: './yakumo.yml',
  initial: [
    { name: 'yakumo' },
  ],
})
await ctx.use(Cli, {
  name: 'yakumo',
})
await ctx.std.cli.executeArgv()

export {}

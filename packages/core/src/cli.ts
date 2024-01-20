#!/usr/bin/env node

import { start } from '@cordisjs/cli'

const args = process.argv.slice(2)

for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--import')) {
    const [arg] = args.splice(i, 1)
    let [, path] = arg.split('=')
    if (!path) {
      path = args.splice(i, 1)[0]
    }
    await import(path)
    --i
  }
}

await start({ name: 'yakumo' })

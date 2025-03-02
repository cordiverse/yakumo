#!/usr/bin/env node

import { start } from 'cordis/cli'

for (let i = 2; i < process.argv.length; i++) {
  if (!process.argv[i].startsWith('--import')) break
  const [arg] = process.argv.splice(i, 1)
  let [, path] = arg.split('=')
  if (!path) {
    path = process.argv.splice(i, 1)[0]
  }
  await import(path)
  --i
}

await start({
  name: 'yakumo',
  initial: [
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

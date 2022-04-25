import { addHook } from 'yakumo'
import Mocha from 'mocha'
import globby from 'globby'

addHook('command/mocha', async ({ targets, cwd }) => {
  const patterns = Object
    .keys(targets)
    .map(folder => `${folder}/tests/*.spec.ts`.slice(1))

  const mocha = new Mocha()
  mocha.files = await globby(patterns, { cwd })
  mocha.run(failures => process.exit(failures))
})

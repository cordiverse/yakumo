import { register } from 'yakumo'
import Mocha from 'mocha'
import globby from 'globby'

Error.stackTraceLimit = 50

register('mocha', async (project) => {
  const { cwd, argv } = project
  const patterns = argv._.map((arg: string) => {
    const [folder] = arg.split('/', 1)
    const name = arg.slice(folder.length + 1) || '*'
    return `${project.locate(folder)}/tests/${name}.spec.ts`.slice(1)
  })

  const mocha = new Mocha()
  mocha.files = await globby(patterns, { cwd })
  mocha.run(failures => process.exit(failures))
}, {
  manual: true,
})

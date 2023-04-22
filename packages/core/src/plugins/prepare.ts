import { install, register } from '..'
import picomatch from 'picomatch'

register('prepare', async (project) => {
  const { workspaces } = project.workspaces['']
  const current = new Set(workspaces)
  if (!current.size) return
  const match = picomatch(workspaces)
  let hasUpdate = false
  for (const prefix in project.workspaces) {
    if (!prefix) continue
    const { workspaces = [] } = project.workspaces[prefix]
    for (const path of workspaces) {
      const result = prefix.slice(1) + '/' + path
      if (match(result)) continue
      console.log(`[I] workspace added: ${result}`)
      current.add(result)
      hasUpdate = true
    }
    for (const path of current) {
      if (!path.startsWith(prefix.slice(1) + '/')) continue
      if (workspaces.includes(path.slice(prefix.length))) continue
      if (project.argv.clean) {
        console.log(`[W] workspace removed: ${path}`)
        current.delete(path)
        hasUpdate = true
      } else {
        console.log(`[W] workspace mismatch: ${path}`)
      }
    }
  }
  if (hasUpdate) {
    project.workspaces[''].workspaces = [...current].sort()
    await project.save('')
    await install()
  }
}, {
  manual: true,
  alias: {
    clean: ['c'],
  },
})

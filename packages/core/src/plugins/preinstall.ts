import { register } from '..'
import picomatch from 'picomatch'

register('preinstall', async (project) => {
  const current = project.workspaces[''].workspaces
  const match = picomatch(current)
  let hasUpdate = false
  for (const prefix in project.workspaces) {
    if (!prefix) continue
    const { workspaces = [] } = project.workspaces[prefix]
    for (const path of workspaces) {
      const result = prefix.slice(1) + '/' + path
      if (match(result)) continue
      console.log(`[I] workspace added: ${result}`)
      current.push(result)
      hasUpdate = true
    }
  }
  if (hasUpdate) {
    current.sort()
    await project.save('')
  }
}, { manual: true })

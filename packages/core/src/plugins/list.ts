import { Dict } from 'cosmokit'
import { Context } from 'cordis'

interface Node {
  name: string
  path: string
  children: Node[]
  tree: Dict<Node>
}

export const inject = ['yakumo']

export function apply(ctx: Context) {
  function createNode(path: string): Node {
    return { name: ctx.yakumo.workspaces[path].name, path, children: [], tree: {} }
  }

  function findParent(root: Node, path: string) {
    for (const prefix in root.tree) {
      if (path.startsWith(prefix)) return findParent(root.tree[prefix], path)
    }
    return root
  }

  function printNode(node: Node, indent: boolean[] = []) {
    const prefix = indent.map((isLastItem, index) => {
      const isLastIndent = index === indent.length - 1
      return isLastIndent
        ? isLastItem ? '└── ' : '├── '
        : isLastItem ? '    ' : '│   '
    }).join('')
    console.log(`${prefix}${node.name}${node.path ? ` (${node.path.slice(1)})` : ''}`)
    node.children.forEach((child, index) => {
      const isLast = index === node.children.length - 1
      printNode(child, [...indent, isLast])
    })
  }

  ctx.register('list', async () => {
    const paths = Object.keys(ctx.yakumo.workspaces).sort()
    const root: Node = createNode(paths.shift()!)
    const total = paths.length
    let workspaces = 1
    for (const path of paths) {
      const node = createNode(path)
      const parent = findParent(root, path)
      parent.children.push(node)
      if (ctx.yakumo.workspaces[path].workspaces) {
        parent.tree[path] = node
        workspaces++
      }
    }
    printNode(root)
    console.log(`${total} packages, ${workspaces} workspaces`)
  })
}

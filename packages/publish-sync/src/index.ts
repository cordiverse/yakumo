import { Context } from 'yakumo'
import {} from 'yakumo-publish'

export function apply(ctx: Context) {
  ctx.on('publish/after', async (name, meta) => {
    await fetch('https://registry-direct.npmmirror.com/' + meta.name + '/sync?sync_upstream=true', {
      method: 'PUT',
    })
  })
}

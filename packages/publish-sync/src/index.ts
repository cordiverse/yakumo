import { addHook } from 'yakumo'
import axios from 'axios'
import {} from 'yakumo-publish'

addHook('publish.after', async (name, meta) => {
  await axios.put('https://registry-direct.npmmirror.com/' + meta.name + '/sync?sync_upstream=true')
})

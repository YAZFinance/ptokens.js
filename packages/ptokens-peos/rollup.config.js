import pkg from './package.json'
import rollupConfig from '../../rollup.config'

export default rollupConfig('pEOS', pkg.name, {
  'ptokens-node-selector': 'ptokens-node-selector',
  'ptokens-utils': 'ptokens-utils'
})

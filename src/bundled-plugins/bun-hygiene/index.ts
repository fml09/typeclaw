import { definePlugin } from '@/plugin'

import {
  GUARD_GLOBAL_INSTALL,
  GUARD_NON_BUN_PACKAGE_MANAGER,
  GUARD_NON_BUN_PACKAGE_RUNNER,
  checkBunHygieneGuard,
} from './policy'

export default definePlugin({
  guardAcknowledgements: [
    { key: GUARD_GLOBAL_INSTALL, tools: ['bash'] },
    { key: GUARD_NON_BUN_PACKAGE_MANAGER, tools: ['bash'] },
    { key: GUARD_NON_BUN_PACKAGE_RUNNER, tools: ['bash'] },
  ],
  plugin: async () => ({
    hooks: {
      'tool.before': (event) => checkBunHygieneGuard({ tool: event.tool, args: event.args }),
    },
  }),
})

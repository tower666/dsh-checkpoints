/**
 * Agent-facing half of the same operation the Web card performs.
 *
 * `revert` asks the composed approval answerers first: the request is a
 * destructive write, so it is rejected unless the outcome is `allowed-once`.
 * A tool always runs inside an open turn, which is exactly the precondition
 * `ctx.approval.request()` documents.
 */

/** Cap on the paths quoted in an approval reason. */
const REASON_PATHS = 8

/** The tool's model-facing description. */
const DESCRIPTION = [
  'Inspect and restore the workspace files of one conversation turn from the persistent checkpoint this plugin keeps in a shadow git repository.',
  'Use action "list" to see the recorded turns of this Session and the files each one changed.',
  'Use action "revert" with side "start" to undo the files that turn changed, or with side "end" to make the workspace look like the end of that turn — keeping everything up to it and dropping every later change.',
  'It asks the user for approval before any file is written and keeps the overwritten state so the revert can be undone.',
  'Oversized or binary snapshot blobs are reported as unsupported instead of being written.',
].join(' ')

/**
 * Register the tool once both the tool registry and the approval service exist.
 * @param ctx - plugin context.
 * @param service - the checkpoint service.
 * @param log - plugin logger.
 */
export function registerTool(ctx, service, log) {
  ctx.inject(['tools', 'approval'], (scope) => {
    const definition = {
      name: 'workspace_checkpoint',
      description: DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'revert'],
            description: 'list the recorded turns, or revert files to one turn’s checkpoint.',
          },
          turn: {
            type: 'number',
            description: 'The turn number to revert; required for action "revert".',
          },
          side: {
            type: 'string',
            enum: ['start', 'end'],
            description: 'start (default) undoes the files this turn changed by restoring their content at the start of the turn; end restores the workspace to the end of this turn, dropping every change made after it.',
          },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Workspace-relative files to revert. Omit to revert every file the turn changed.',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [
          { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
        ],
      },
      async execute(args, exec) {
        const input = args !== null && typeof args === 'object' ? args : {}
        const sessionId = exec.agent?.id
        if (typeof sessionId !== 'string') {
          return { ok: false, error: 'workspace_checkpoint needs a Session-scoped agent.' }
        }
        if (input.action === 'list') {
          return { ok: true, turns: await service.turns(sessionId) }
        }
        if (input.action !== 'revert') {
          return { ok: false, error: 'action must be "list" or "revert".' }
        }
        const side = input.side === 'end' ? 'end' : 'start'
        const plan = await service.prepare({
          sessionId,
          turn: input.turn,
          side,
          ...(Array.isArray(input.paths) && input.paths.length > 0 ? { paths: input.paths } : {}),
        })
        const files = plan.files.filter((file) => file.action === 'restore' || file.action === 'delete')
        if (files.length === 0) {
          return { ok: false, error: 'This turn has no revertable file on that side.', plan }
        }
        const quoted = files.slice(0, REASON_PATHS).map((file) => file.path)
        if (files.length > quoted.length) quoted.push(`… (${files.length - quoted.length} more)`)
        const outcome = await scope.approval.request({
          agent: exec.agent,
          toolName: definition.name,
          callId: exec.callId,
          reason: `Revert ${files.length} file(s) in ${plan.workspace} to the ${side} of turn ${plan.turn}: ${quoted.join(', ')}`,
          displayReason: {
            en: `Revert ${files.length} file(s) to the ${side} of turn ${plan.turn}`,
            zh: `把 ${files.length} 个文件回退到第 ${plan.turn} 轮${side === 'start' ? '开始' : '结束'}时的内容`,
          },
          signal: exec.signal,
        })
        if (outcome !== 'allowed-once') {
          log.info(`checkpoint revert denied by approval policy: ${outcome}`)
          return { ok: false, denied: true, outcome, plan }
        }
        return await service.restore({ planId: plan.planId })
      },
    }
    scope.effect(() => scope.tools.register(definition), 'checkpoints: tool')
  })
}

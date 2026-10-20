import { runAgent } from '../agent.js'
import { startRequest } from '../telemetry.js'
import { postEventToServer } from '../event-sync.js'
import { logger } from '../logger.js'

/**
 * runAgent plus a telemetry row, so committee spend reaches agent_events and the
 * server cost gate (trader daily/monthly caps) can see it. Without this the
 * committee ran untracked and the caps could not stop it.
 */
export const trackedRunAgent: typeof runAgent = async (message, sessionId, onTyping, guardHarden, onEvent, actionPlan, runtimeContext) => {
  const projectId = runtimeContext?.projectId ?? actionPlan?.projectId ?? 'trader'
  const tracker = startRequest('trader', 'api', (actionPlan?.source ?? 'committee').slice(0, 80), undefined, projectId)
  if (actionPlan?.source) tracker.setAgentId(actionPlan.source)
  tracker.markAgentStarted()
  try {
    return await runAgent(message, sessionId, onTyping, guardHarden, (event) => {
      tracker.recordSdkEvent(event)
      onEvent?.(event)
    }, actionPlan, runtimeContext)
  } finally {
    try {
      tracker.finalize()
      postEventToServer(tracker.toEventRow()).catch((err: unknown) => logger.warn({ err }, 'Committee telemetry sync failed (non-fatal)'))
    } catch (err) {
      logger.warn({ err }, 'Committee telemetry finalize failed (non-fatal)')
    }
  }
}

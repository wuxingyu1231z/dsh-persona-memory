import type { Context } from '@deepseek-ai/cordis'
import type { PeerScope, PeerId } from '@deepseek-ai/dsh-typert-protocol'

/** Explicit local-owner identity for in-process Gateway tests; not a wire argument. */
export function ownerPeer(ctx: Context): PeerScope {
  return { id: 'persona-test-owner' as PeerId, ctx, principal: { kind: 'owner' }, signal: new AbortController().signal, interactions: 'none', async dispose() {} }
}

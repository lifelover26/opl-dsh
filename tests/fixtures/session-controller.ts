/** Official Controller transport seam over the real SessionStore used in tests. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionController, SessionEventsPage } from '@deepseek-ai/dsh-api-session-controller'

export function sessionHistoryFixture(ctx: Context): Pick<SessionController, 'events' | 'prompt'> {
  return {
    async events(request, signal) {
      signal.throwIfAborted()
      const id =
        request.address.kind === 'session'
          ? request.address.sessionId
          : request.address.childSessionId
      const session = ctx.sessions.get(id)
      if (session === undefined) throw Error(`fixture Session ${id} is absent`)
      const cursor = request.throughSeq ?? Number(session.seq) - 1
      const before = request.beforeSeq ?? cursor + 1
      const records = session
        .snapshotEvents()
        .filter((event) => event.seq <= cursor && event.seq < before)
        .map((event) => ({ type: 'event' as const, event }))
      return { cursor, records, hasMore: false } as unknown as SessionEventsPage
    },
    async prompt() {
      return { accepted: true }
    },
  }
}

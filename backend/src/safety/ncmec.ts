/**
 * NCMEC CyberTipline reporting hook.
 *
 * LEGAL: Under 18 U.S.C. § 2258A, any Electronic Service Provider that obtains
 * ACTUAL KNOWLEDGE of apparent CSAM on its systems must report to the NCMEC
 * CyberTipline "as soon as reasonably possible". The REPORT Act (May 2024)
 * extended retention of CyberTipline-related data to 1 year.
 *
 * NEVER store the actual prompt/content of a flagged CSAM request in plaintext.
 * Doing so could constitute possession under federal law. This module accepts
 * only:
 *   - metadata (timestamps, user id, source ip, classifier scores)
 *   - an opaque sha256 content hash
 *   - classifier layer that triggered the flag
 *
 * The actual NCMEC CyberTipline submission is out of scope here (requires ESP
 * registration and authenticated API access). This module queues events for
 * an out-of-band reporting worker.
 */
import crypto from 'node:crypto'
import { loadEnv } from '../config/env.js'
import { getDb } from '../db/client.js'
import { safetyEvents, type NewSafetyEvent } from '../db/schema.js'

export interface NcmecReportInput {
  userId: string | null
  requestLogId: string | null
  layer: 'keyword' | 'moderation' | 'llamaguard' | 'output'
  decision: 'blocked_keyword' | 'blocked_moderation' | 'blocked_llamaguard' | 'blocked_csam'
  categories: string[]
  scores?: Record<string, number>
  /** Raw content — hashed immediately, NEVER stored. */
  content: string
}

/**
 * Record a safety event and queue it for NCMEC reporting.
 * Retains for 1 year (REPORT Act requirement).
 */
export async function recordSafetyEvent(input: NcmecReportInput): Promise<{ id: string } | null> {
  const env = loadEnv()
  const contentHash = crypto.createHash('sha256').update(input.content).digest('hex')

  const retainUntil = new Date()
  retainUntil.setFullYear(retainUntil.getFullYear() + 1)

  const row: NewSafetyEvent = {
    userId: input.userId,
    requestLogId: input.requestLogId,
    decision: input.decision,
    categories: input.categories,
    scores: input.scores,
    layer: input.layer,
    contentHash,
    reportedToNcmec: false,
    retainUntil,
  }

  if (!process.env.DATABASE_URL) {
    console.warn('[safety] DB not configured, safety event not persisted:', {
      decision: input.decision,
      categories: input.categories,
      contentHash,
    })
    if (env.NCMEC_REPORTING_ENABLED) {
      await queueForNcmecReporting({ ...row, id: 'in-memory' })
    }
    return null
  }

  const db = getDb()
  const [inserted] = await db.insert(safetyEvents).values(row).returning({ id: safetyEvents.id })

  if (inserted && env.NCMEC_REPORTING_ENABLED && input.decision === 'blocked_csam') {
    await queueForNcmecReporting({ ...row, id: inserted.id })
  }

  return inserted ?? null
}

/**
 * Queue a safety event for out-of-band NCMEC CyberTipline submission.
 *
 * The real submission requires:
 *   1. ESP registration with NCMEC (get ESP ID + API credentials)
 *   2. XML submission per CyberTipline schema
 *   3. Authenticated POST to NCMEC's REST endpoint
 *   4. Retention of confirmation id for ≥1 year
 *
 * This stub logs the event with enough metadata for an operator to manually
 * file a report. A production deployment should implement the XML submission
 * in a separate worker so request handling latency is unaffected.
 */
async function queueForNcmecReporting(event: NewSafetyEvent & { id: string }): Promise<void> {
  const env = loadEnv()
  console.warn('[NCMEC] queued CyberTipline report', {
    eventId: event.id,
    espId: env.NCMEC_ESP_ID ?? '<not-configured>',
    decision: event.decision,
    categories: event.categories,
    contentHash: event.contentHash,
    layer: event.layer,
    timestamp: new Date().toISOString(),
  })
  // TODO: implement actual CyberTipline XML submission in worker.
}

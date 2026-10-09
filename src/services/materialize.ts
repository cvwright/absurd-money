/**
 * Materializing the budget schedule (0025): posting the scheduled allocations that the
 * `budget` topic doesn't hold yet. See "Allocations are events; the schedule is config" in
 * design/ACCOUNTING.md.
 *
 * Check-then-append, with the topic's own chain as the compare-and-swap: read the whole
 * topic, work out which `idem`s are missing, and post each on the head just read. If
 * another device posts first, the post is rejected, and the topic is read again. Should two
 * devices both get a duplicate through anyway, the fold counts only the first.
 *
 * This module knows nothing about the SDK; `BudgetTopic` is the seam.
 */

import { foldBudget } from '@/core/fold/budget.js';
import type { RawMessage } from '@/core/fold/segment.js';
import type { EnvelopeId, Label, Month } from '@/core/ids.js';
import { encodeMessage, type BudgetDoc } from '@/core/messages.js';
import { dueAllocations } from '@/core/schedule.js';
import { allocationPostProblems } from '@/core/validate.js';
import { StaleHeadError } from './state-store.js';
import { TopicConflictError } from './topic-append.js';

export interface BudgetTopic {
  /** Every message on `budget`, decrypted, in chain order. */
  read(): Promise<RawMessage[]>;
  /**
   * Posts an allocation on `prevHash` and returns the new message's hash. Throws
   * `StaleHeadError` if `prevHash` is not the head.
   */
  post(data: Uint8Array, prevHash: string | null): Promise<string>;
}

const MAX_ATTEMPTS = 5;

/**
 * Posts every allocation `budget`'s schedule calls for through `through` that `topic`
 * doesn't already hold, oldest month first. Returns how many were posted.
 *
 * Throws, posting nothing more, if the topic holds a message type or version this client
 * doesn't know: the fold stops there, so it can't tell which months are done.
 */
export async function materializeSchedule(
  topic: BudgetTopic,
  budget: BudgetDoc,
  through: Month,
  idem: (envelope: EnvelopeId, month: Month) => Label,
): Promise<number> {
  let posted = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const messages = await topic.read();
    const fold = foldBudget(messages, budget);
    if (fold.halted) {
      throw new Error(`The budget holds a message this version can't read (${fold.halted.error.message}). Update the app.`);
    }
    const done = new Set(fold.allocations.flatMap((a) => (a.msg.idem === undefined ? [] : [a.msg.idem])));
    let head: string | null = messages.at(-1)?.id ?? null;
    try {
      for (const alloc of dueAllocations(budget, through, done, idem)) {
        const problems = allocationPostProblems(alloc, budget);
        if (problems.length > 0) throw new Error(`scheduled allocation: ${problems.join('; ')}`);
        head = await topic.post(new TextEncoder().encode(encodeMessage('ledger.allocation', alloc)), head);
        posted++;
      }
      return posted;
    } catch (err) {
      if (!(err instanceof StaleHeadError)) throw err;
    }
  }
  throw new TopicConflictError('budget', MAX_ATTEMPTS);
}

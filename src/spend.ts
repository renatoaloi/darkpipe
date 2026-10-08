/**
 * spend.ts — every call that can spend money appends exactly one ledger event
 * before the command exits. Dry runs never reach this function.
 */

import type { CostEvent, Ledger, ProviderCallResult } from './ports.ts';
import { isoNow, round } from './lib/util.ts';

export interface SpendContext {
  caseId: string | null;
  shot: number | null;
  kind: string;
  jobId?: string | null;
}

export function toEvent(
  context: SpendContext,
  result: Partial<ProviderCallResult>,
  status: 'ok' | 'error',
  at: Date = new Date(),
): CostEvent {
  return {
    at: isoNow(at),
    case: context.caseId,
    shot: context.shot,
    kind: context.kind,
    provider: result.provider ?? 'unknown',
    model: result.model ?? 'unknown',
    usd: round(result.usd ?? 0, 6),
    tokens_in: result.tokensIn ?? null,
    tokens_out: result.tokensOut ?? null,
    latency_ms: result.latencyMs ?? null,
    job_id: result.jobId ?? context.jobId ?? null,
    status,
  };
}

/**
 * Run one paid call and record it. A charged failure records the charged usd and
 * `status: "error"`, then rethrows so the command still exits non-zero.
 */
export async function metered<T extends ProviderCallResult>(
  ledger: Ledger,
  context: SpendContext,
  call: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await call();
    const latency = result.latencyMs ?? Date.now() - started;
    await ledger.append(toEvent(context, { ...result, latencyMs: latency }, 'ok'));
    return result;
  } catch (error) {
    const partial = error as Partial<ProviderCallResult> & { provider?: string; model?: string };
    await ledger.append(
      toEvent(
        context,
        {
          provider: partial?.provider ?? 'unknown',
          model: partial?.model ?? 'unknown',
          usd: typeof partial?.usd === 'number' ? partial.usd : 0,
          latencyMs: Date.now() - started,
        },
        'error',
      ),
    );
    throw error;
  }
}

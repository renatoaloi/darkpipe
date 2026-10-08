/**
 * jobs — list and cancel long runs. Owner: task group 7.
 *
 * There is no daemon: `ctx.jobs` reads `.darkpipe/jobs.json`. Cancelling marks
 * the job `cancelled` and sends SIGTERM to its pid; it never deletes case files.
 */

import type { Command, CommandContext } from '../command.ts';
import type { CommandResult } from '../lib/util.ts';
import { requirePositional } from '../lib/args.ts';
import type { JobRecord } from '../jobs.ts';

function describe(record: JobRecord): string {
  const when = record.status === 'running' ? `started ${record.started_at}` : `ended ${record.ended_at ?? '?'}`;
  return `${record.id}  ${record.status.padEnd(9)}  pid ${String(record.pid).padEnd(7)}  ${record.label}  (${when})`;
}

async function listJobs(ctx: CommandContext): Promise<CommandResult> {
  const records = await ctx.jobs.list();
  const running = records.filter((record) => record.status === 'running');
  const finished = records.filter((record) => record.status !== 'running');
  const lines: string[] = [];
  lines.push(`jobs: ${running.length} running, ${finished.length} finished`);
  for (const record of records) lines.push(`  ${describe(record)}`);
  if (records.length === 0) lines.push('  (none)');
  return {
    data: { running: running.length, finished: finished.length, jobs: records },
    text: lines,
  };
}

async function cancelJob(ctx: CommandContext): Promise<CommandResult> {
  const id = requirePositional(ctx.args, 0, 'job id');
  const record = await ctx.jobs.cancel(id);
  return {
    data: { job: record, status: record.status },
    text: [`job ${record.id} is now ${record.status}`, 'case files written before the cancel stay on disk'],
  };
}

export const jobsCommand: Command = {
  name: 'jobs',
  summary: 'list and cancel long runs',
  usage: ['darkpipe jobs', 'darkpipe jobs list', 'darkpipe jobs cancel <id>'],
  sub: {
    list: { name: 'list', summary: 'list running and finished jobs', run: listJobs },
    cancel: { name: 'cancel', summary: 'stop a running job by id', run: cancelJob },
  },
  run: listJobs,
};

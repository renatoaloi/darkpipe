/**
 * commands/index.ts — the command table. `--help` prints it in COMMAND_ORDER.
 * No agenda command: the pipeline does not do calendars or seeding.
 */

import type { Command } from '../command.ts';
import { doctorCommand } from './doctor.ts';
import { configCommand } from './config.ts';
import { caseCommand } from './case.ts';
import { competeCommand } from './compete.ts';
import { narrateCommand } from './narrate.ts';
import { voiceCommand } from './voice.ts';
import { planCommand } from './plan.ts';
import { promptsCommand } from './prompts.ts';
import { timelineCommand } from './timeline.ts';
import { generateCommand } from './generate.ts';
import { stillCommand } from './still.ts';
import { renderCommand } from './render.ts';
import { styleCommand } from './style.ts';
import { shortsCommand } from './shorts.ts';
import { postsCommand } from './posts.ts';
import { costsCommand } from './costs.ts';
import { jobsCommand } from './jobs.ts';
import { publishCommand } from './publish.ts';

export const COMMANDS: Record<string, Command> = {
  doctor: doctorCommand,
  config: configCommand,
  case: caseCommand,
  compete: competeCommand,
  narrate: narrateCommand,
  voice: voiceCommand,
  plan: planCommand,
  prompts: promptsCommand,
  timeline: timelineCommand,
  generate: generateCommand,
  still: stillCommand,
  render: renderCommand,
  style: styleCommand,
  shorts: shortsCommand,
  posts: postsCommand,
  costs: costsCommand,
  jobs: jobsCommand,
  publish: publishCommand,
};

export const COMMAND_ORDER: string[] = [
  'doctor',
  'config',
  'case',
  'compete',
  'narrate',
  'voice',
  'plan',
  'prompts',
  'timeline',
  'generate',
  'still',
  'render',
  'style',
  'shorts',
  'posts',
  'costs',
  'jobs',
  'publish',
];

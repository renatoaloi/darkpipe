/**
 * registry.ts — the composition root's adapter table. `src/cli.ts` reads config,
 * asks this table for a factory by port + adapter name, and hands the built
 * ports to commands. Commands never import an adapter.
 */

import type {
  CaseFiles,
  CaseStore,
  Ledger,
  MediaProvider,
  PortName,
  Ports,
  Publisher,
  Renderer,
  SpeechProvider,
  TextProvider,
} from '../ports.ts';
import type { AdapterSetting, DarkpipeConfig } from '../config.ts';
import { DarkpipeError } from '../lib/util.ts';
import { fakeMediaFactory, fakePublisherFactory, fakeSpeechFactory, fakeTextFactory, failingTextFactory } from './fakes.ts';
import { sqliteStoreFactory } from './store-sqlite.ts';
import { caseFilesFactory } from './files-casefs.ts';
import { runwareMediaFactory, runwareSpeechFactory, runwareTextFactory } from './runware.ts';
import { jsonlLedgerFactory } from './ledger-jsonl.ts';
import { ffmpegRendererFactory } from './render-ffmpeg.ts';
import { youtubePublisherFactory } from './publisher-youtube.ts';

export interface AdapterContext {
  repoRoot: string;
  config: DarkpipeConfig;
}

export interface AdapterFactory<T> {
  name: string;
  port: PortName;
  create(context: AdapterContext, settings: AdapterSetting): T;
}

const TABLES = {
  store: [sqliteStoreFactory],
  files: [caseFilesFactory],
  media: [runwareMediaFactory, fakeMediaFactory],
  speech: [runwareSpeechFactory, fakeSpeechFactory],
  text: [runwareTextFactory, fakeTextFactory, failingTextFactory],
  render: [ffmpegRendererFactory],
  ledger: [jsonlLedgerFactory],
  publisher: [youtubePublisherFactory, fakePublisherFactory],
} satisfies Record<PortName, AdapterFactory<unknown>[]>;

export function adapterNames(port: PortName): string[] {
  return (TABLES[port] as AdapterFactory<unknown>[]).map((factory) => factory.name);
}

export function allAdapterNames(): Record<PortName, string[]> {
  return {
    store: adapterNames('store'),
    files: adapterNames('files'),
    media: adapterNames('media'),
    speech: adapterNames('speech'),
    text: adapterNames('text'),
    render: adapterNames('render'),
    ledger: adapterNames('ledger'),
    publisher: adapterNames('publisher'),
  };
}

function resolveFactory<T>(port: PortName, settings: AdapterSetting): AdapterFactory<T> {
  const wanted = settings.adapter;
  const factories = TABLES[port] as AdapterFactory<T>[];
  const factory = factories.find((candidate) => candidate.name === wanted);
  if (factory === undefined) {
    throw new DarkpipeError(`unknown ${port} adapter "${wanted}"`, {
      port,
      hint: `known ${port} adapters: ${factories.map((f) => f.name).join(', ')}. Fix "darkpipe.config.json" (key ${port}.adapter).`,
    });
  }
  return factory;
}

/**
 * Build every port from config. Every adapter name is resolved before any
 * adapter is constructed, so a typo fails by port name and nothing half-built
 * is left behind.
 */
export function buildPorts(repoRoot: string, config: DarkpipeConfig): Ports {
  const context: AdapterContext = { repoRoot, config };
  const resolved = {
    store: resolveFactory<CaseStore>('store', config.store),
    files: resolveFactory<CaseFiles>('files', config.files),
    media: resolveFactory<MediaProvider>('media', config.media),
    speech: resolveFactory<SpeechProvider>('speech', config.speech),
    text: resolveFactory<TextProvider>('text', config.text),
    render: resolveFactory<Renderer>('render', config.render),
    ledger: resolveFactory<Ledger>('ledger', config.ledger),
    publisher: resolveFactory<Publisher>('publisher', config.publisher),
  };
  return {
    store: resolved.store.create(context, config.store),
    files: resolved.files.create(context, config.files),
    media: resolved.media.create(context, config.media),
    speech: resolved.speech.create(context, config.speech),
    text: resolved.text.create(context, config.text),
    render: resolved.render.create(context, config.render),
    ledger: resolved.ledger.create(context, config.ledger),
    publisher: resolved.publisher.create(context, config.publisher),
  };
}

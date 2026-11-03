import {
  LIMITS,
  type Category,
  type LocalWorkspaceState,
  type PromptElement,
  type PromptTemplate,
  type SyncRequest,
  type SyncResponse,
} from '../shared/types.ts';
import { applySyncResponse, hasUnsyncedChanges } from './storage.ts';

export const DEFAULT_MAX_CHUNK_BYTES = 3_500_000;

type TaggedDirtyItem =
  | { kind: 'category'; item: Category; bytes: number }
  | { kind: 'element'; item: PromptElement; bytes: number }
  | { kind: 'template'; item: PromptTemplate; bytes: number };

const encoder = new TextEncoder();

function estimateJsonBytes(item: object): number {
  return encoder.encode(JSON.stringify(item)).byteLength + 16;
}

/**
 * Splits dirty entities into chunks bounded by both `chunkSize` (default 500 records)
 * and `maxChunkBytes` (default 3.5 MB, well under the server's 5 MB bodyLimit).
 * Categories are always ordered before elements, and elements before templates.
 */
export function buildSyncChunks(
  state: LocalWorkspaceState,
  chunkSize: number = LIMITS.clientSyncChunkSize,
  maxChunkBytes: number = DEFAULT_MAX_CHUNK_BYTES,
): SyncRequest[] {
  const dirtyCatSet = new Set(state.dirtyCategoryIds);
  const dirtyElSet = new Set(state.dirtyElementIds);
  const dirtyTmplSet = new Set(state.dirtyTemplateIds);

  const queue: TaggedDirtyItem[] = [
    ...state.categories
      .filter((c) => dirtyCatSet.has(c.id))
      .map((item): TaggedDirtyItem => ({ kind: 'category', item, bytes: estimateJsonBytes(item) })),
    ...state.elements
      .filter((e) => dirtyElSet.has(e.id))
      .map((item): TaggedDirtyItem => ({ kind: 'element', item, bytes: estimateJsonBytes(item) })),
    ...state.templates
      .filter((t) => dirtyTmplSet.has(t.id))
      .map((item): TaggedDirtyItem => ({ kind: 'template', item, bytes: estimateJsonBytes(item) })),
  ];

  if (queue.length === 0) {
    return [
      {
        sinceSeq: state.lastSyncedSeq,
        categories: [],
        elements: [],
        templates: [],
      },
    ];
  }

  const chunks: SyncRequest[] = [];
  let currentCategories: Category[] = [];
  let currentElements: PromptElement[] = [];
  let currentTemplates: PromptTemplate[] = [];
  let currentCount = 0;
  let currentBytes = 64;

  const flushChunk = () => {
    if (currentCount === 0) return;
    chunks.push({
      sinceSeq: state.lastSyncedSeq,
      categories: currentCategories,
      elements: currentElements,
      templates: currentTemplates,
    });
    currentCategories = [];
    currentElements = [];
    currentTemplates = [];
    currentCount = 0;
    currentBytes = 64;
  };

  for (const entry of queue) {
    if (
      currentCount > 0 &&
      (currentCount >= chunkSize || currentBytes + entry.bytes > maxChunkBytes)
    ) {
      flushChunk();
    }
    if (entry.kind === 'category') currentCategories.push(entry.item);
    else if (entry.kind === 'element') currentElements.push(entry.item);
    else currentTemplates.push(entry.item);
    currentCount += 1;
    currentBytes += entry.bytes;
  }

  flushChunk();
  return chunks;
}

/**
 * Runs a full sync cycle by computing one chunk at a time from the latest state
 * after applying each server response (so category canonicalizations in chunk 1
 * immediately remap pending elements before chunk 2 is built).
 */
export async function runSyncCycle(
  initialState: LocalWorkspaceState,
  sendSync: (req: SyncRequest) => Promise<SyncResponse>,
  chunkSize: number = LIMITS.clientSyncChunkSize,
  maxChunkBytes: number = DEFAULT_MAX_CHUNK_BYTES,
): Promise<LocalWorkspaceState> {
  let current = initialState;
  let sentAtLeastOne = false;
  let safetyCounter = 0;
  const maxIterations =
    current.dirtyCategoryIds.length +
    current.dirtyElementIds.length +
    current.dirtyTemplateIds.length +
    2;

  while ((!sentAtLeastOne || hasUnsyncedChanges(current)) && safetyCounter < maxIterations) {
    safetyCounter += 1;
    sentAtLeastOne = true;
    const nextChunk = buildSyncChunks(current, chunkSize, maxChunkBytes)[0]!;
    const response = await sendSync(nextChunk);
    current = applySyncResponse(
      current,
      {
        categories: nextChunk.categories,
        elements: nextChunk.elements,
        templates: nextChunk.templates,
      },
      response,
    );
  }

  return current;
}

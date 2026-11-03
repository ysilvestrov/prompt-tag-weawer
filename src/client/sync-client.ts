import {
  LIMITS,
  type Category,
  type LocalWorkspaceState,
  type PromptElement,
  type PromptTemplate,
  type SyncRequest,
  type SyncResponse,
} from '../shared/types.ts';
import { applySyncResponse } from './storage.ts';

type TaggedDirtyItem =
  | { kind: 'category'; item: Category }
  | { kind: 'element'; item: PromptElement }
  | { kind: 'template'; item: PromptTemplate };

/**
 * Splits dirty entities into chunks of at most `chunkSize` (default 500),
 * ordering categories first, then elements, then templates so parent categories
 * always precede their child elements.
 */
export function buildSyncChunks(
  state: LocalWorkspaceState,
  chunkSize: number = LIMITS.clientSyncChunkSize,
): SyncRequest[] {
  const dirtyCatSet = new Set(state.dirtyCategoryIds);
  const dirtyElSet = new Set(state.dirtyElementIds);
  const dirtyTmplSet = new Set(state.dirtyTemplateIds);

  const queue: TaggedDirtyItem[] = [
    ...state.categories
      .filter((c) => dirtyCatSet.has(c.id))
      .map((item): TaggedDirtyItem => ({ kind: 'category', item })),
    ...state.elements
      .filter((e) => dirtyElSet.has(e.id))
      .map((item): TaggedDirtyItem => ({ kind: 'element', item })),
    ...state.templates
      .filter((t) => dirtyTmplSet.has(t.id))
      .map((item): TaggedDirtyItem => ({ kind: 'template', item })),
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
  for (let i = 0; i < queue.length; i += chunkSize) {
    const slice = queue.slice(i, i + chunkSize);
    const categories: Category[] = [];
    const elements: PromptElement[] = [];
    const templates: PromptTemplate[] = [];

    for (const entry of slice) {
      if (entry.kind === 'category') categories.push(entry.item);
      else if (entry.kind === 'element') elements.push(entry.item);
      else templates.push(entry.item);
    }

    chunks.push({
      sinceSeq: state.lastSyncedSeq,
      categories,
      elements,
      templates,
    });
  }

  return chunks;
}

export async function runSyncCycle(
  initialState: LocalWorkspaceState,
  sendSync: (req: SyncRequest) => Promise<SyncResponse>,
  chunkSize: number = LIMITS.clientSyncChunkSize,
): Promise<LocalWorkspaceState> {
  let current = initialState;
  const chunks = buildSyncChunks(current, chunkSize);

  for (const chunk of chunks) {
    const request: SyncRequest = {
      ...chunk,
      sinceSeq: current.lastSyncedSeq,
    };
    const response = await sendSync(request);
    current = applySyncResponse(
      current,
      request.categories.map((c) => c.id),
      request.elements.map((e) => e.id),
      request.templates.map((t) => t.id),
      response,
    );
  }

  return current;
}

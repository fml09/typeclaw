import { readFile } from 'node:fs/promises'

import { z } from 'zod'

import { defineTool } from '@/plugin'

export const findEntryTool = defineTool({
  description:
    'Locate a session-transcript entry by its `id` field and report the 1-indexed line number. ' +
    'Use this BEFORE calling `read` on a large transcript so you can pass `offset=<lineNumber>+1` ' +
    'and resume reading right after the watermark, instead of scanning the file from the top in 50KB chunks. ' +
    "Matches the entry's own `id` field only, not `parentId` references. Returns the line number, total " +
    'line count, and a suggested next offset for `read`. Returns a "not found" string (does not throw) ' +
    'when no entry carries the id, so the caller can decide whether to start from line 1 or stop.',
  parameters: z.object({
    path: z.string().describe('Path to the JSONL transcript file to scan.'),
    entryId: z
      .string()
      .min(1)
      .describe('The entry id to locate (matches the JSONL row whose own `id` field equals this value).'),
  }),
  // `path` is a real local file this tool reads; declaring it pins an immutable
  // snapshot before readFile (and restores the original path in the result)
  // instead of the scanner rejecting the bare `sessions/...jsonl` path.
  fileOperands: {
    input: ['path'],
    nonFile: ['entryId'],
  },
  async execute({ path, entryId }) {
    if (entryId.length === 0) {
      throw new Error('find_entry requires a non-empty entryId; an empty needle would match every line.')
    }
    const raw = await readFile(path, 'utf8')
    const lines = raw.length === 0 ? [] : raw.split('\n')
    const totalLines = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length

    const needle = `"id":"${entryId}"`
    let foundLine: number | null = null
    for (let i = 0; i < totalLines; i++) {
      if (lines[i]?.includes(needle)) {
        foundLine = i + 1
        break
      }
    }

    if (foundLine === null) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `entryId=${entryId} not found in ${path} (totalLines=${totalLines}). The watermark may point at an entry that has since been removed (e.g. compaction). Consider starting from offset=1 or skip this run.`,
          },
        ],
        details: { path, entryId, found: false, totalLines },
      }
    }

    const nextOffset = foundLine + 1
    return {
      content: [
        {
          type: 'text' as const,
          text: `entryId=${entryId} found at line=${foundLine} of totalLines=${totalLines}. Use read(path="${path}", offset=${nextOffset}) to resume past this entry.`,
        },
      ],
      details: { path, entryId, found: true, line: foundLine, totalLines, nextOffset },
    }
  },
})

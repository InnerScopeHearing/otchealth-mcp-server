import { z } from 'zod';

const segment = (part: string) => part.length > 0 && part.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(part) && !part.includes('..') && !/[. ]$/.test(part);
/** Broker references only: one named relative tree, never a local filesystem path. */
export const browserDirectoryManifestSchema = z.array(z.object({
  fileId: z.string().uuid(),
  relativePath: z.string().max(512).refine(path => {
    const parts = path.split('/');
    return parts.length >= 2 && parts.length <= 8 && parts.every(segment);
  }),
}).strict()).min(1).max(32).superRefine((entries, context) => {
  const paths = new Set<string>(), ids = new Set<string>();
  const root = entries[0]?.relativePath.split('/')[0];
  for (const entry of entries) {
    if (paths.has(entry.relativePath) || ids.has(entry.fileId) || entry.relativePath.split('/')[0] !== root) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Directory manifest is invalid.' });
    paths.add(entry.relativePath); ids.add(entry.fileId);
  }
  // Every entry is a file. No file may also be a directory needed by another
  // entry, irrespective of caller ordering or a shared text-only prefix.
  for (const path of paths) {
    const parts = path.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      if (paths.has(parts.slice(0, depth).join('/'))) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Directory manifest is invalid.' });
        break;
      }
    }
  }
});

import { z } from "zod";

import { listCursor, listLimit } from "@/lib/api/query";

/**
 * `GET /api/v1/tags` query (FR-API-08): just the shared page controls. A
 * Workspace's tag vocabulary is small, so agents narrow client-side; the
 * endpoint exists so an agent can discover the exact stored names before a
 * `PATCH` (`addTags`/`removeTags`) or a `tag` list filter, both of which
 * match names as they are written: trimmed, lower-cased.
 */
export const tagListQuery = z.strictObject({
  limit: listLimit,
  cursor: listCursor,
});

/** What a Tag read through the API carries: the name writes and filters use, nothing more. */
type TagRow = {
  id: string;
  name: string;
};

export function serializeTag(tag: TagRow) {
  return {
    id: tag.id,
    name: tag.name,
  };
}

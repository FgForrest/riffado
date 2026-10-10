import type { ChatterItemKind } from "@/db/schema";

/** Every item kind: for the routes that work the same on each. */
export const ALL_ITEM_KINDS: readonly ChatterItemKind[] = ["audio", "mail"];

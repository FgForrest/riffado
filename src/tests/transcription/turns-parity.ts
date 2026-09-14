import { expect } from "vitest";
import {
    renderTurnsAsText,
    type TranscriptTurn,
} from "@/lib/transcription/turns";

/**
 * Assert that a provider's flat transcript text and its structured turns are
 * two renderings of one grouping.
 *
 * Every diarizing provider stores both, and every read seam re-renders the
 * turns to apply speaker names. If the two are built by separate passes they
 * drift, and the same transcript then reads differently depending on whether
 * anyone has been named. One statement of the invariant, shared by all four
 * provider suites, so a new provider inherits the assertion rather than a
 * re-spelled variant of it.
 */
export function expectTextAndTurnsAgree(
    text: string,
    turns: readonly TranscriptTurn[] | undefined,
): void {
    expect(turns).toBeDefined();
    expect(renderTurnsAsText(turns ?? [])).toBe(text);
}

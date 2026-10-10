import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
    env: {
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
}));

import { audioContentFrom } from "@/lib/content/audio-content";
import { isSubstantive, isValidAnchor, textAt } from "@/lib/content/types";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";

describe("audio content", () => {
    it("reads timed turns as spoken segments under their speaker labels", () => {
        const content = audioContentFrom({
            id: "t1",
            recordingId: "r1",
            text: encryptText("speaker_0: Hello\nspeaker_1: Hi"),
            turns: encryptJsonField([
                { speaker: "speaker_0", startMs: 0, endMs: 900, text: "Hello" },
                { speaker: "speaker_1", startMs: 900, endMs: 1500, text: "Hi" },
            ]),
            revision: 3,
            detectedLanguage: "en",
        });
        expect(content).toMatchObject({
            itemId: "r1",
            kind: "audio",
            sourceId: "t1",
            revision: 3,
            language: "en",
            participants: [
                { ref: "speaker_0", roles: ["speaker"], displayName: null },
                { ref: "speaker_1", roles: ["speaker"], displayName: null },
            ],
        });
        expect(content.segments).toEqual([
            {
                index: 0,
                role: "spoken",
                participantRef: "speaker_0",
                depth: 0,
                at: null,
                startMs: 0,
                endMs: 900,
                text: "Hello",
            },
            {
                index: 1,
                role: "spoken",
                participantRef: "speaker_1",
                depth: 0,
                at: null,
                startMs: 900,
                endMs: 1500,
                text: "Hi",
            },
        ]);
    });

    it("splits a transcript without stored turns by its speaker lines, untimed", () => {
        const content = audioContentFrom({
            id: "t1",
            recordingId: "r1",
            text: encryptText("speaker_0: Hello\nspeaker_1: Hi"),
            turns: null,
            revision: 0,
            detectedLanguage: null,
        });
        expect(
            content.segments.map((s) => [s.participantRef, s.text, s.startMs]),
        ).toEqual([
            ["speaker_0", "Hello", undefined],
            ["speaker_1", "Hi", undefined],
        ]);
    });

    it("reads an unlabelled transcript as one segment by nobody known", () => {
        const content = audioContentFrom({
            id: "t1",
            recordingId: "r1",
            text: encryptText("Just a note to self."),
            turns: null,
            revision: 0,
            detectedLanguage: null,
        });
        expect(content.participants).toEqual([]);
        expect(content.segments).toHaveLength(1);
        expect(content.segments[0]?.participantRef).toBeNull();
    });
});

describe("content anchors", () => {
    const content = {
        segments: [
            {
                index: 0,
                role: "body" as const,
                participantRef: "p1",
                depth: 0,
                at: null,
                text: "We answer by Friday.",
            },
        ],
    };

    it("checks the form of both anchor kinds", () => {
        expect(isValidAnchor({ kind: "time", startMs: 0, endMs: 0 })).toBe(
            true,
        );
        expect(isValidAnchor({ kind: "time", startMs: 5, endMs: 1 })).toBe(
            false,
        );
        expect(
            isValidAnchor({
                kind: "text",
                segmentIndex: 0,
                charStart: 3,
                charEnd: 3,
            }),
        ).toBe(false);
    });

    it("reads the words a text anchor covers, and nothing past its segment", () => {
        expect(
            textAt(content, {
                kind: "text",
                segmentIndex: 0,
                charStart: 13,
                charEnd: 19,
            }),
        ).toBe("Friday");
        expect(
            textAt(content, {
                kind: "text",
                segmentIndex: 0,
                charStart: 13,
                charEnd: 99,
            }),
        ).toBeNull();
        expect(
            textAt(content, {
                kind: "text",
                segmentIndex: 1,
                charStart: 0,
                charEnd: 1,
            }),
        ).toBeNull();
    });

    it("counts only what was said or written as substantive", () => {
        const roles = [
            "spoken",
            "body",
            "quoted",
            "signature",
            "quoted_signature",
            "disclaimer",
        ] as const;
        expect(
            roles.filter((role) =>
                isSubstantive({ ...content.segments[0], role }),
            ),
        ).toEqual(["spoken", "body", "quoted"]);
    });
});

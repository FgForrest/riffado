import { describe, expect, it } from "vitest";
import {
    planSpeakerMerge,
    type SpeakerMergeRow,
} from "@/lib/knowledge/merge-plan";

function row(
    id: string,
    transcriptionId: string,
    label: string,
    status: SpeakerMergeRow["status"] = "suggested",
): SpeakerMergeRow {
    return { id, transcriptionId, label, status };
}

describe("planSpeakerMerge", () => {
    it("repoints a loser row whose slot the winner does not hold", () => {
        const plan = planSpeakerMerge([], [row("l1", "t1", "speaker_0")]);

        expect(plan).toEqual({
            repointLoserIds: ["l1"],
            dropLoserIds: [],
            dropWinnerIds: [],
        });
    });

    it("drops the loser when the winner already holds the same slot", () => {
        const plan = planSpeakerMerge(
            [row("w1", "t1", "speaker_0")],
            [row("l1", "t1", "speaker_0")],
        );

        expect(plan.dropLoserIds).toEqual(["l1"]);
        expect(plan.repointLoserIds).toEqual([]);
        expect(plan.dropWinnerIds).toEqual([]);
    });

    it("prefers a confirmed loser over a suggested winner", () => {
        const plan = planSpeakerMerge(
            [row("w1", "t1", "speaker_0", "suggested")],
            [row("l1", "t1", "speaker_0", "confirmed")],
        );

        expect(plan.dropWinnerIds).toEqual(["w1"]);
        expect(plan.repointLoserIds).toEqual(["l1"]);
        expect(plan.dropLoserIds).toEqual([]);
    });

    it("keeps a confirmed winner over a confirmed loser", () => {
        const plan = planSpeakerMerge(
            [row("w1", "t1", "speaker_0", "confirmed")],
            [row("l1", "t1", "speaker_0", "confirmed")],
        );

        expect(plan.dropLoserIds).toEqual(["l1"]);
        expect(plan.dropWinnerIds).toEqual([]);
    });

    it("treats the same label in different transcripts as different slots", () => {
        const plan = planSpeakerMerge(
            [row("w1", "t1", "speaker_0")],
            [row("l1", "t2", "speaker_0")],
        );

        expect(plan.repointLoserIds).toEqual(["l1"]);
        expect(plan.dropLoserIds).toEqual([]);
    });

    it("treats different labels in the same transcript as different slots", () => {
        const plan = planSpeakerMerge(
            [row("w1", "t1", "speaker_0")],
            [row("l1", "t1", "speaker_1")],
        );

        expect(plan.repointLoserIds).toEqual(["l1"]);
    });

    it("handles a mix across several transcripts", () => {
        const plan = planSpeakerMerge(
            [
                row("w1", "t1", "speaker_0", "suggested"),
                row("w2", "t2", "speaker_1", "confirmed"),
            ],
            [
                row("l1", "t1", "speaker_0", "confirmed"),
                row("l2", "t2", "speaker_1", "suggested"),
                row("l3", "t3", "speaker_0", "suggested"),
            ],
        );

        expect(plan.dropWinnerIds).toEqual(["w1"]);
        expect(plan.repointLoserIds).toEqual(["l1", "l3"]);
        expect(plan.dropLoserIds).toEqual(["l2"]);
    });

    it("does nothing when there is nothing to merge", () => {
        expect(planSpeakerMerge([], [])).toEqual({
            repointLoserIds: [],
            dropLoserIds: [],
            dropWinnerIds: [],
        });
    });
});

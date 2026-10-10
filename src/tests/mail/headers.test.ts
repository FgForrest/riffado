import { describe, expect, it } from "vitest";
import {
    dkimTags,
    headerValuesOf,
    readRawHeaders,
    withDkimSignatures,
} from "@/lib/mail/headers";

const RAW = Buffer.from(
    [
        "DKIM-Signature: v=1; d=company.example; s=google;",
        "\th=from:to; t=1791656728; b=AAA",
        "DKIM-Signature: v=1; d=relay.example; s=x; b=BBB",
        "From: Jan <jan@company.example>",
        "To: acme-weekly@klepna.example",
        "DKIM-Signature: v=1; d=last.example; s=y; b=CCC",
        "",
        "Hello",
        "",
    ].join("\r\n"),
);

describe("raw headers", () => {
    it("reads headers in order, unfolded", () => {
        const headers = readRawHeaders(RAW);
        expect(headers.map((header) => header.name)).toEqual([
            "DKIM-Signature",
            "DKIM-Signature",
            "From",
            "To",
            "DKIM-Signature",
        ]);
        expect(headers[0]?.value).toBe(
            "v=1; d=company.example; s=google; h=from:to; t=1791656728; b=AAA",
        );
        expect(headerValuesOf(headers, "from")).toEqual([
            "Jan <jan@company.example>",
        ]);
    });

    it("reads DKIM tags", () => {
        const tags = dkimTags(readRawHeaders(RAW)[0]?.value ?? "");
        expect(tags.get("d")).toBe("company.example");
        expect(tags.get("h")).toBe("from:to");
        expect(tags.get("t")).toBe("1791656728");
    });

    it("drops signatures without touching the rest, the last one included", () => {
        const kept = withDkimSignatures(RAW, (_header, index) => index === 0);
        expect(kept.toString()).toBe(
            [
                "DKIM-Signature: v=1; d=company.example; s=google;",
                "\th=from:to; t=1791656728; b=AAA",
                "From: Jan <jan@company.example>",
                "To: acme-weekly@klepna.example",
                "",
                "Hello",
                "",
            ].join("\r\n"),
        );
        expect(withDkimSignatures(RAW, () => true)).toBe(RAW);
    });

    it("reads a message with bare LF line ends", () => {
        const lf = Buffer.from("From: a@b.example\nSubject: x\n\nbody\n");
        expect(readRawHeaders(lf).map((header) => header.name)).toEqual([
            "From",
            "Subject",
        ]);
    });
});

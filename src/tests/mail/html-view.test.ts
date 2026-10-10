import { describe, expect, it } from "vitest";
import { renderMailHtml } from "@/lib/mail/html-view";

function multipart(html: string, image?: { cid: string; png: Buffer }): Buffer {
    const parts = [
        "From: jan@company.example",
        "To: jan@klepna.example",
        "Subject: Formatted",
        "MIME-Version: 1.0",
        'Content-Type: multipart/related; boundary="b1"',
        "",
        "--b1",
        "Content-Type: text/html; charset=utf-8",
        "",
        html,
    ];
    if (image) {
        parts.push(
            "--b1",
            "Content-Type: image/png",
            "Content-Transfer-Encoding: base64",
            `Content-ID: <${image.cid}>`,
            "Content-Disposition: inline",
            "",
            image.png.toString("base64"),
        );
    }
    parts.push("--b1--", "");
    return Buffer.from(parts.join("\r\n"));
}

describe("formatted mail", () => {
    it("runs nothing and fetches nothing", async () => {
        const html = await renderMailHtml(
            multipart(
                [
                    '<p onclick="steal()">Hello <b>there</b></p>',
                    "<script>steal()</script>",
                    '<img src="https://tracker.example/pixel.gif">',
                    '<div style="background:url(https://tracker.example/bg); color:red">styled</div>',
                    '<a href="javascript:steal()">bad link</a>',
                    '<a href="https://example.com/doc">good link</a>',
                    "<style>body{background:url(https://tracker.example/x)}</style>",
                    '<iframe src="https://example.com"></iframe>',
                    '<form action="https://example.com"><input name="x"></form>',
                ].join(""),
            ),
        );
        expect(html).not.toBeNull();
        const out = html ?? "";
        expect(out).toContain("<b>there</b>");
        expect(out).not.toMatch(
            /onclick|<script|steal\(\)|<iframe|<form|<input/i,
        );
        expect(out).not.toContain("tracker.example");
        expect(out).toContain("color:red");
        expect(out).toContain('href="https://example.com/doc"');
        expect(out).not.toContain("javascript:");
        expect(out).toContain(
            "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
        );
    });

    it("inlines cid: images as data URIs", async () => {
        const png = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
            "base64",
        );
        const html = await renderMailHtml(
            multipart('<p>Logo: <img src="cid:logo@company.example"></p>', {
                cid: "logo@company.example",
                png,
            }),
        );
        expect(html).toContain('src="data:image/png;base64,');
        expect(html).not.toContain("cid:");
    });

    it("has nothing to show for a plain-text mail", async () => {
        const raw = Buffer.from(
            "From: a@company.example\r\nSubject: x\r\n\r\nJust text\r\n",
        );
        expect(await renderMailHtml(raw)).toBeNull();
    });
});

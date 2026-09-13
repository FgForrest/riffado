/**
 * What the summary renderer must and must not do with model output.
 *
 * The text rendered here is written by a language model working from a
 * transcript, so it is not attacker-controlled in the usual sense -- but it is
 * not authored by us either, and it reaches the page as markup. These pin the
 * two things that matter: structure comes through, and nothing in the string
 * can introduce an element we did not choose.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "@/components/markdown";

function render(markdown: string, inline = false): string {
    return renderToStaticMarkup(
        <Markdown inline={inline}>{markdown}</Markdown>,
    );
}

describe("markdown rendering", () => {
    it("turns a list into list elements rather than literal dashes", () => {
        const html = render("- one\n- two");
        expect(html).toContain("<ul");
        expect(html).toContain("<li");
        expect(html).not.toContain("- one");
    });

    it("renders headings, bold and numbered lists", () => {
        const html = render("## Topic\n\n1. first\n2. second\n\n**bold**");
        expect(html).toMatch(/<h\d/);
        expect(html).toContain("<ol");
        expect(html).toContain("<strong>bold</strong>");
    });

    it("renders GFM tables", () => {
        const html = render("| a | b |\n| - | - |\n| 1 | 2 |");
        expect(html).toContain("<table");
        expect(html).toContain("<td");
    });

    it("shows plain prose unchanged, which is what old summaries are", () => {
        // Every summary written before this feature is a bare paragraph.
        const html = render("A single paragraph with no formatting at all.");
        expect(html).toContain("A single paragraph with no formatting at all.");
    });
});

describe("markdown safety", () => {
    it("does not emit raw HTML from the model", () => {
        const html = render(
            'Before <img src="x" onerror="alert(1)"> after\n\n<script>alert(2)</script>',
        );
        expect(html).not.toContain("<script");
        expect(html).not.toContain("onerror");
        expect(html).not.toContain('<img src="x"');
    });

    it("neutralises a javascript: link", () => {
        const html = render("[click](javascript:alert(1))");
        expect(html).not.toContain("javascript:");
    });

    it("opens links without handing over the opener", () => {
        const html = render("[docs](https://example.com)");
        expect(html).toContain('rel="noopener noreferrer"');
        expect(html).toContain('target="_blank"');
    });
});

describe("the bracket convention the merge prompt enforces", () => {
    it("keeps [Topic] prefixes as literal text", () => {
        // The merge prompt groups entries by a leading [bracket]. Markdown
        // only treats those as links when a matching definition exists, and
        // none ever does -- but if that ever changed the prefixes would
        // silently vanish from every merged summary.
        const html = render("[Recording] Long-press the button", true);
        expect(html).toContain("[Recording] Long-press the button");
        expect(html).not.toContain("<a");
    });

    it("keeps nested [A] [B] prefixes as literal text", () => {
        const html = render("[Feedback] [John] wants shorter syncs", true);
        expect(html).toContain("[Feedback] [John] wants shorter syncs");
        expect(html).not.toContain("<a");
    });
});

describe("inline mode", () => {
    it("does not wrap a key point in its own paragraph or bullet", () => {
        // The list item around it already supplies the bullet and spacing.
        const html = render("a single key point", true);
        expect(html).not.toContain("<p");
        expect(html).not.toContain("<li");
    });

    it("still renders emphasis inside a key point", () => {
        const html = render("an **important** point", true);
        expect(html).toContain("<strong>important</strong>");
    });
});

/**
 * What a summary of a mail is told: its own framing beside the shared
 * Markdown, content-is-data and language directives. Pure constants.
 */

/** The built-in template a mail is summarized with unless one is chosen. */
export const MAIL_SUMMARY_PROMPT = `Summarize this mail, then extract key points and action items if any exist.

Respond with a single JSON object and nothing else. Do not wrap it in code fences.
{
  "summary": "A Markdown summary of the mail",
  "keyPoints": ["key point 1", "key point 2"],
  "actionItems": ["action item 1", "action item 2"]
}

Say who writes to whom and what they ask for, offer, decide or report. Keep it to one tight paragraph unless the mail, with the messages it quotes, moves through several distinct topics; then use a short opening paragraph and a "###" section per topic.

If there are no key points or action items, return empty arrays.

Mail:
{transcription}`;

export const MAIL_SUMMARY_SYSTEM =
    "You are a helpful assistant that summarizes mail. Always respond with one raw JSON object and nothing else: no code fences, and no text before or after it. Markdown inside the JSON string values is expected.";

/** How a mail's participants and parts are to be read. */
export const MAIL_PARTICIPANT_DIRECTIVE = `PEOPLE AND PARTS OF A MAIL:

- The participants are listed as p1, p2, ... with the name and domain the mail gives. Refer to people by those names. Never infer or invent a name, title or organization the mail does not state.
- A part labelled "quoted" was written earlier by its stated author and is quoted here: attribute what it says to that author, never to the sender of this mail.
- "signature" and "disclaimer" parts describe their writer and organization. Do not summarize them.`;

/** The action-item contract for a mail; replaces the recording's. */
export const MAIL_TASKS_DIRECTIVE = `ACTION ITEMS: whatever the instructions above say about "actionItems", every entry in it is an object of this shape, and the reply also carries "taskUpdates" (an empty array unless told otherwise below):
{"text": string, "speaker": "pN" | null, "assignee": string | null, "due": {"phrase": string, "date": "YYYY-MM-DD" | null} | null, "quote": string | null}

- One entry per deliverable per person. Fold the steps of one deliverable into a single entry. Leave out what was only mentioned, offered without agreement, or is already done.
- "text": the action as one short line, without the person who does it ("Send the signed contract", not "p2 sends the signed contract").
- "speaker": the participant reference (p1, p2, ...) of the person who has to do it, when they take part in the mail; otherwise null.
- "assignee": when the person who has to do it is not a participant, their name as the mail gives it; otherwise null. Both null when nobody was named.
- "due": only when a deadline was given. "phrase" is the deadline as written, in the mail's language. "date" is the day it names, worked out from the mail's date given with it; the last day of a named week or month for "end of"; null when it names no single day.
- "quote": up to 12 words copied exactly from the mail where the action was asked for or agreed.`;

---
title: Exports, backups and retention
description: Folder exports to disk or Google Drive, backups, and deleting old data automatically.
---

## Folder exports

A folder export keeps a copy of a folder's recordings outside Riffado, on a disk or in Google Drive, and keeps it up to date. Your administrator decides which of the two your instance offers.

Open a folder (see [Folders](recordings.md#folders)) and click **Settings**:

![Folder export settings](images/folder-export.png)

### To a disk

Click **Add filesystem export**, give a folder name under the instance's export directory, and choose what to write:

![A filesystem export](images/folder-export-filesystem.png)

- **Audio**: the original recording.
- **Transcript**: the transcript, in every form it has.
- **Summary**: the summary, in every form it has.
- **Mail** (where your instance receives mail): each mail as it arrived (`message.eml`, attachments included) and as a readable `mail.md` with its summary and tasks. Off until you turn it on; an export of mail alone is fine.

Click **Save export**. The export covers the folder and every folder inside it. Files are named after the recordings' titles.

### To Google Drive

First connect your Google account in **Settings → Google Account**. Then click **Add Google Drive export**, pick a Drive folder, and choose for transcripts and summaries whether to write Markdown files, Google Docs, or both. Riffado can only see that folder and the files it creates there. Google Docs are rewritten when the recording changes, so edits you make in them are overwritten.

### How an export stays up to date

- A recording you file into the folder is written; one you take out is removed.
- A recording you move or rename moves or renames its files instead of being written again.
- Files of a deleted recording, a removed transcript or summary, or a kind you switched off are deleted from the export.
- A recording filed in several folders has one copy in each.
- Riffado never touches files it did not create. Audio that [retention](#deleting-old-data-automatically) removed from Riffado stays in the export.
- The organization account's export writes a shared mail's `mail.md` only, its secret addresses hidden: the message as it arrived stays its sender's.
- **Synchronize** checks the export and writes again anything that went missing.

## Backups

![Export and backup](images/settings-export.png)

**Settings → Export/Backup** takes your data with you:

- **Export text** downloads your transcripts and summaries straight away, in the **Default export format** (JSON, TXT, SRT or VTT).
- **Create full backup** builds one archive with everything: audio, transcripts, summaries, your Almanac, Learn reviews and tasks. Large libraries take a few minutes; you get an email when it is ready, and a **Download** button appears.
- **Backup frequency** builds the archive daily, weekly or monthly without you having to remember.

Each archive stays downloadable for seven days. A backup holds your own recordings, the shared ones included, without what colleagues added to them. The organization account's backup holds every shared recording, with its owner.

## Deleting old data automatically

![Auto-delete old data](images/settings-retention.png)

**Settings → Storage → Auto-delete old data** deletes old copies on a schedule. Each kind has its own period, from 1 to 365 days, and is off until you turn it on:

- **Remote original**: moves the original on your recorder's cloud to its Trash, but only after Riffado has its own copy.
- **Local audio**: Riffado's copy of the sound.
- **Local transcript** and **Local summary**: these can be made again while the audio is still there.

The recording stays in your library with a note saying what was removed, and Riffado does not bring it back on its own. The top of the Storage page shows how much space your recordings take, and which ones take the most.

Where your instance receives mail, **Auto-delete old mail** below it does the same for mail, counted from when a mail arrived:

- **Mail as it arrived**: the stored message with its attachments.
- **Mail text**: the text Riffado read. Facts learned only from it are deleted with it.
- **Mail summary**: the summary and the tasks proposed from it.

The mail stays in your pile with its sender, recipients and subject, and says what was removed. While a mail is shared into the Organization, the Organization's mail policy applies to it instead of yours.

Next: [Settings](settings.md)

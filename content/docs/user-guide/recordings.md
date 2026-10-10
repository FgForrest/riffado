---
title: Recordings
description: The recording list, the player, uploads, folders, erasing, and what the AI cost.
---

## The recording list

The list on the left of **Recordings** shows your newest recordings first, grouped by day. Each row shows the title and the first words of the transcript, or the length and date when there is no transcript yet.

![The recording list with the Needs review filter on](images/recording-list-needs-review.png)

- **Search** finds words in titles and transcripts. It reads corrected transcripts, so a name Learn fixed is found as you spell it. It also finds a mail by its sender and by what the mail itself says, not by the earlier messages it quotes, its signature or its disclaimer.
- **Newest** changes the order: newest first, oldest first, or by name.
- **Needs review** appears when Learn has proposals waiting on some recordings, and shows just those. See [Learn](learn.md).
- **Organize** switches the list to your folders. See [Folders](#folders).
- The **⋯** menu on a row opens the recording, downloads its audio, or deletes it.

## Adding recordings

Recordings arrive in two ways:

- **From your recorder.** Riffado fetches new recordings from your recorder's cloud on a schedule, when you open the app, and when you click **Sync device**. Settings → Sync controls how often.
- **By upload.** Click **Upload** and pick an audio or a video file. For a video, Riffado keeps only the sound: the file is uploaded, the audio is extracted in the background, and a message tells you when it is ready. One video is converted at a time. Uploaded recordings are transcribed automatically when **Auto-transcribe new recordings** is on (Settings → Transcription).

Recording a meeting held in the browser on Linux? Your administrator can give you **meetrec**, a small command-line recorder that captures both your microphone and the other participants into one file, ready to upload. See [For administrators](administrators.md#meeting-recorder-meetrec).

## The recording page

Click a recording to open it on the right.

![A recording](images/dashboard.png)

At the top:

- **The title.** Click the pencil next to it to rename the recording. A title you set yourself is never replaced by a generated one.
- **When, how long, how large.**
- **Estimated AI spend** (see below).
- **Folder chips** with the folders it is filed in, and **Add to folder**.
- **Erase** on the right (see below).

Below that are the player, the [transcript](transcripts.md) and the [summary](summaries-and-tasks.md).

### The player

The player shows the recording as a waveform. Click anywhere on it to jump there. **1x** changes the speed, the speaker icon and slider set the volume, and the download icon saves the original audio file. If you prefer a plain progress bar, choose it in **Settings → Playback → Scrubber style**.

### What the AI cost

![Estimated AI spend, opened](images/ai-spend.png)

Click **Estimated AI spend** to see what each step cost on this recording: transcription, summary, topics, Learn and the title, and below that, which provider and model did the work. Prices come from each provider's published price list, or from the price you entered on the provider (see [AI providers](settings.md#ai-providers)). For Claude Code and Codex, which run on a subscription, the amount shows what the same work would cost through the API; it is not a charge. Requests made before cost tracking was added are not counted.

### Erasing

![The Erase menu](images/erase-menu.png)

**Erase** removes parts of a recording and keeps the rest:

- **Erase local audio** removes Riffado's copy of the sound. The transcript and summary stay. While the original is still on your recorder's cloud, **Restore audio from Plaud** brings it back.
- **Erase transcripts** and **Erase summaries** remove just those.
- **Delete all local data** removes the recording from Riffado but leaves the original on your recorder's cloud.
- **Move Plaud original to Trash** moves the original to the Trash of your recorder's cloud.
- **Delete everywhere** does both. You confirm by typing the recording's title.

A recording shared with the Organization is taken out of the Organization first. See [The Organization](organization.md).

## Folders

Click **Organize** above the list to see your folders.

![Folders](images/folders.png)

- **Private** holds your own folders. Every recording is in Private, whatever else it is filed in.
- **Organization** holds the folders you share with colleagues. It appears only when your instance has an Organization. See [The Organization](organization.md).

To file a recording, drag its row onto a folder, or open the recording and use **Add to folder**:

![Add to folder](images/add-to-folder.png)

A recording can sit in several folders at once. Click the **×** on a folder chip to take it out of that folder.

To manage folders, use the **⋯** menu next to a folder: **New subfolder**, **Rename**, **Move to…** and **Delete**. You can also drag folders to reorder or nest them. Deleting a folder never deletes the recordings in it.

Click a folder to see its recordings in a table you can sort by title, date, length or size:

![A folder](images/folder-pane.png)

**Settings** on a folder sets up an export of the folder to disk or to Google Drive. See [Exports, backups and retention](exports-backups-retention.md#folder-exports).

Next: [Transcripts](transcripts.md)

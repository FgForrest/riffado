---
title: Mail
description: Sending mail into your Chatter pile.
---

When your administrator has set it up, mail can join your recordings. Mail sent to your addresses lands in your **Chatter** pile, encrypted, beside your recordings. The type filter above the list shows **All**, **Audio** or **Mail**.

Mail needs single sign-on: you get addresses once you sign in with your organization's account. They pause if you have not signed in that way for a long time, and resume at your next sign-in.

## Your addresses

**Settings → Mail** lists them.

- Your **mailbox** (`jan@…`) files mail into your pile, unfiled.
- Every folder has an address (`jan+weekly@…`) that files mail straight into it.

Only mail you send yourself, from the account you sign in with, is accepted on these addresses: forward a mail to one, or put it in **To**, **Cc** or **Bcc** when you write. Riffado checks the mail's signature, so nobody can send in your name.

## Folder addresses

A folder's header shows its address. Copy it, or give the folder an address of your own: the old one keeps working as a secondary address until you remove it. An address that was ever given out is never given to anyone else.

Deleting a folder stops its addresses, and its subfolders', for good. Riffado shows when each last received mail before you confirm.

## Organization folders

Organization folders have addresses that start with the organization's name (`acme-weekly@…`). Any colleague may send to them, in **To** or **Cc** (not **Bcc**). The mail stays yours: it waits in your pile until you share it, as a recording would, and the Organization reads it once shared.

You can also share any of your mail by filing it into an Organization folder. Colleagues read a shared mail, its attachments and its formatted version; only you delete it or download the original message.

## Secret addresses

For mail you do not send yourself, create a **secret address** in **Settings → Mail**. It extends your mailbox or a folder address with a random part (`jan.k3x9…@…`) and files mail the same way, from any sender. Anyone who knows it can send to it, so give it a name you recognize, and **replace** or **stop** it when it leaks.

### Gmail filters and automatic forwarding

Automatic forwarding keeps the original sender, so it needs a secret address.

1. Create a secret address and copy it.
2. In Gmail, open **Settings → Forwarding and POP/IMAP → Add a forwarding address** and enter it.
3. Gmail sends a confirmation code to the address. It arrives in your Chatter pile as a mail from Google: open it and enter the code in Gmail.
4. Create a Gmail filter whose action forwards to that address.

## Reading mail

A mail shows who sent it, with **Verified** when the sender's domain signed it, the recipients and the date. Quoted and forwarded messages are folded under their author. **Show formatted** shows the mail as it was designed, with nothing loaded from the internet. Attachments download only.

Mail sent by machines (auto-replies, mailing lists, notices) is kept but never summarized.

## The delivery log

**Settings → Mail → Delivery log** lists what became of mail sent to your addresses in the last 30 days: received, already received, or refused and why. Refused mail is not kept.

Next: [Exports, backups and retention](exports-backups-retention.md)

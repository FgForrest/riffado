import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    accounts,
    instanceState,
    mailAddresses,
    recordingFolders,
    users,
} from "@/db/schema";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { env } from "@/lib/env";
import { AppError, ErrorCode } from "@/lib/errors";
import { blockSecretsOfInTx } from "@/lib/mail/address-blocking";
import {
    folderAddressCandidates,
    mailboxNameCandidates,
    manualFolderAddress,
    normalizeRecipientLocalPart,
    organizationFolderPrefix,
    personalFolderPrefix,
    secretLocalPart,
} from "@/lib/mail/address-rules";
import { allOrgNicknames, isMailEnabled, orgNickname } from "@/lib/mail/config";
import { localPartHash, MAIL_HASH_VERSION } from "@/lib/mail/hash";
import type { MailUser } from "@/lib/mail/policy";
import { SSO_PROVIDER_ID } from "@/lib/sso/constants";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export type MailAddressKind = "mailbox" | "folder" | "secret";

/** An address as the policy and the settings page read it. */
export interface MailAddressRow {
    id: string;
    kind: MailAddressKind;
    localPart: string;
    namespaceUserId: string | null;
    folderId: string | null;
    baseAddressId: string | null;
    status: "active" | "paused" | "blocked";
    primary: boolean;
    label: string | null;
    lastReceivedAt: Date | null;
    createdAt: Date;
}

/** Give up on a name after this many taken candidates (never in practice). */
const MAX_CANDIDATES = 500;

/** The unique constraint a write ran into, or null for any other error. */
function uniqueViolation(error: unknown): string | null {
    const value = error as {
        code?: unknown;
        constraint_name?: unknown;
        cause?: { code?: unknown; constraint_name?: unknown };
    };
    const inner = value?.code === "23505" ? value : value?.cause;
    if (inner?.code !== "23505") return null;
    return typeof inner.constraint_name === "string"
        ? inner.constraint_name
        : "";
}

/**
 * SQL predicate on `users`: an account that may have mail addresses, a
 * regular user who signs in by single sign-on, whose identity provider
 * vouched for their email. A password account proves nothing about its
 * email, so it never gets one.
 */
export function mailEligibleUserCondition() {
    return sql`${users.role} = 'user' and exists (
        select 1 from ${accounts}
        where ${accounts.userId} = ${users.id}
            and ${accounts.providerId} = ${SSO_PROVIDER_ID}
    )`;
}

/** The earliest single sign-on that still keeps a user's mail receiving. */
export function activeSince(now: Date = new Date()): Date {
    return new Date(now.getTime() - env.MAIL_INACTIVE_DAYS * 86_400_000);
}

function toMailUser(
    row: { id: string; email: string; lastSsoLoginAt: Date | null },
    now: Date,
): MailUser {
    return {
        userId: row.id,
        email: row.email.toLowerCase(),
        active:
            row.lastSsoLoginAt !== null &&
            row.lastSsoLoginAt.getTime() >= activeSince(now).getTime(),
    };
}

/** The eligible user `userId` as the policy sees them, or null. */
export async function mailUserById(
    userId: string,
    now: Date = new Date(),
    executor: Executor = db,
): Promise<MailUser | null> {
    const [row] = await executor
        .select({
            id: users.id,
            email: users.email,
            lastSsoLoginAt: users.lastSsoLoginAt,
        })
        .from(users)
        .where(and(eq(users.id, userId), mailEligibleUserCondition()))
        .limit(1);
    return row ? toMailUser(row, now) : null;
}

/** The eligible user whose verified email `email` is, or null. */
export async function mailUserByEmail(
    email: string,
    now: Date = new Date(),
    executor: Executor = db,
): Promise<MailUser | null> {
    const [row] = await executor
        .select({
            id: users.id,
            email: users.email,
            lastSsoLoginAt: users.lastSsoLoginAt,
        })
        .from(users)
        .where(
            and(
                sql`lower(${users.email}) = ${email.trim().toLowerCase()}`,
                mailEligibleUserCondition(),
            ),
        )
        .limit(1);
    return row ? toMailUser(row, now) : null;
}

function addressColumns() {
    return {
        id: mailAddresses.id,
        kind: mailAddresses.kind,
        localPart: mailAddresses.localPart,
        namespaceUserId: mailAddresses.namespaceUserId,
        folderId: mailAddresses.folderId,
        baseAddressId: mailAddresses.baseAddressId,
        status: mailAddresses.status,
        primary: mailAddresses.primary,
        label: mailAddresses.label,
        lastReceivedAt: mailAddresses.lastReceivedAt,
        createdAt: mailAddresses.createdAt,
    };
}

function toRow(
    row: Omit<MailAddressRow, "localPart" | "label"> & {
        localPart: string;
        label: string | null;
    },
): MailAddressRow {
    return {
        ...row,
        localPart: decryptText(row.localPart),
        label: row.label ? decryptText(row.label) : null,
    };
}

/**
 * Inserts an address under the first free candidate; null when the
 * candidates run out. Each attempt is a savepoint, so a name another
 * transaction took meanwhile is only a reason to try the next.
 */
async function claimFirstFree(
    tx: Tx,
    candidates: Iterable<string>,
    values: Omit<
        typeof mailAddresses.$inferInsert,
        "localPart" | "localPartHash" | "hashKeyVersion"
    >,
): Promise<{ id: string; localPart: string } | null> {
    let tried = 0;
    for (const localPart of candidates) {
        if (++tried > MAX_CANDIDATES) break;
        const hash = localPartHash(localPart);
        const [taken] = await tx
            .select({ id: mailAddresses.id })
            .from(mailAddresses)
            .where(eq(mailAddresses.localPartHash, hash))
            .limit(1);
        if (taken) continue;
        try {
            const [row] = await tx.transaction((sp) =>
                sp
                    .insert(mailAddresses)
                    .values({
                        ...values,
                        localPart: encryptText(localPart),
                        localPartHash: hash,
                        hashKeyVersion: MAIL_HASH_VERSION,
                    })
                    .returning({ id: mailAddresses.id }),
            );
            if (row) return { id: row.id, localPart };
        } catch (error) {
            const constraint = uniqueViolation(error);
            if (constraint === null) throw error;
            // The name went meanwhile: try the next one. Otherwise the
            // one mailbox or current address a target may have exists now.
            if (constraint === "mail_addresses_local_part_hash_unique")
                continue;
            return null;
        }
    }
    return null;
}

/** The user's live mailbox, or null. */
export async function findMailbox(
    userId: string,
    executor: Executor = db,
): Promise<MailAddressRow | null> {
    const [row] = await executor
        .select(addressColumns())
        .from(mailAddresses)
        .where(
            and(
                eq(mailAddresses.namespaceUserId, userId),
                eq(mailAddresses.kind, "mailbox"),
                ne(mailAddresses.status, "blocked"),
            ),
        )
        .limit(1);
    return row ? toRow(row) : null;
}

/**
 * The user's mailbox, allocated if they are eligible and have none: at
 * their first single sign-on once mail is on, and by the backfill.
 */
export async function ensureMailbox(
    userId: string,
): Promise<MailAddressRow | null> {
    if (!isMailEnabled()) return null;
    const existing = await findMailbox(userId);
    if (existing) return existing;
    const [user] = await db
        .select({ email: users.email })
        .from(users)
        .where(and(eq(users.id, userId), mailEligibleUserCondition()))
        .limit(1);
    if (!user) return null;
    await db.transaction(async (tx) => {
        await claimFirstFree(
            tx,
            mailboxNameCandidates(user.email, allOrgNicknames()),
            {
                kind: "mailbox",
                namespaceUserId: userId,
                createdByUserId: userId,
            },
        );
    });
    return findMailbox(userId);
}

/** A folder's path from its tree's root, decrypted names, root first. */
async function folderPath(
    executor: Executor,
    folderId: string,
): Promise<{ ownerId: string; kind: string; names: string[] } | null> {
    const [folder] = await executor
        .select({ userId: recordingFolders.userId })
        .from(recordingFolders)
        .where(eq(recordingFolders.id, folderId))
        .limit(1);
    if (!folder) return null;
    const tree = await executor
        .select({
            id: recordingFolders.id,
            parentId: recordingFolders.parentId,
            name: recordingFolders.name,
            kind: recordingFolders.kind,
        })
        .from(recordingFolders)
        .where(eq(recordingFolders.userId, folder.userId));
    const byId = new Map(tree.map((row) => [row.id, row]));
    const names: string[] = [];
    let current = byId.get(folderId);
    const kind = current?.kind ?? "custom";
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
        seen.add(current.id);
        names.unshift(decryptText(current.name));
        current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return { ownerId: folder.userId, kind, names };
}

/**
 * The prefix of a folder's addresses: the owner's mailbox and `+`, or the
 * nickname and `-` for the Organization's. Null when the owner has no
 * mailbox (not eligible).
 */
async function folderPrefix(
    executor: Executor,
    ownerId: string,
): Promise<string | null> {
    const [owner] = await executor
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, ownerId))
        .limit(1);
    if (!owner) return null;
    if (owner.role === "org") return organizationFolderPrefix(orgNickname());
    const mailbox = await findMailbox(ownerId, executor);
    return mailbox ? personalFolderPrefix(mailbox.localPart) : null;
}

/** A folder's current address, or null. */
export async function findFolderAddress(
    folderId: string,
    executor: Executor = db,
): Promise<MailAddressRow | null> {
    const [row] = await executor
        .select(addressColumns())
        .from(mailAddresses)
        .where(
            and(
                eq(mailAddresses.folderId, folderId),
                eq(mailAddresses.kind, "folder"),
                eq(mailAddresses.primary, true),
                ne(mailAddresses.status, "blocked"),
            ),
        )
        .limit(1);
    return row ? toRow(row) : null;
}

/**
 * A custom folder's address, assigned from its path if it has none. Roots
 * have none: mail to the mailbox lands unfiled, and `<nick>@` is reserved.
 */
export async function ensureFolderAddress(
    folderId: string,
    actorUserId: string | null = null,
): Promise<MailAddressRow | null> {
    if (!isMailEnabled()) return null;
    const existing = await findFolderAddress(folderId);
    if (existing) return existing;
    const path = await folderPath(db, folderId);
    if (!path || path.kind !== "custom") return null;
    const prefix = await folderPrefix(db, path.ownerId);
    if (!prefix) return null;
    await db.transaction(async (tx) => {
        await claimFirstFree(tx, folderAddressCandidates(prefix, path.names), {
            kind: "folder",
            namespaceUserId: path.ownerId,
            folderId,
            createdByUserId: actorUserId,
        });
    });
    return findFolderAddress(folderId);
}

/**
 * Sets a folder's address to `alias` (made safe); the previous one stays as
 * a secondary address until removed. Refuses a name ever given out.
 */
export async function setFolderAddress(input: {
    actorUserId: string;
    folderId: string;
    alias: string;
}): Promise<MailAddressRow> {
    const path = await folderPath(db, input.folderId);
    if (!path || path.kind !== "custom") {
        throw new AppError(ErrorCode.NOT_FOUND, "Folder not found", 404);
    }
    const prefix = await folderPrefix(db, path.ownerId);
    const localPart = prefix ? manualFolderAddress(prefix, input.alias) : null;
    if (!localPart) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "That address cannot be used",
            400,
            { field: "alias" },
        );
    }
    await db.transaction(async (tx) => {
        await tx
            .update(mailAddresses)
            .set({ primary: false, updatedAt: new Date() })
            .where(
                and(
                    eq(mailAddresses.folderId, input.folderId),
                    eq(mailAddresses.kind, "folder"),
                    eq(mailAddresses.primary, true),
                ),
            );
        const claimed = await claimFirstFree(tx, [localPart], {
            kind: "folder",
            namespaceUserId: path.ownerId,
            folderId: input.folderId,
            createdByUserId: input.actorUserId,
        });
        if (!claimed) {
            throw new AppError(
                ErrorCode.CONFLICT,
                "That address is taken",
                409,
                { field: "alias" },
            );
        }
    });
    const current = await findFolderAddress(input.folderId);
    if (!current) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, "Address not set", 500);
    }
    return current;
}

/** The address a recipient's local part names, blocked ones included. */
export async function resolveLocalPart(
    localPart: string,
    executor: Executor = db,
): Promise<MailAddressRow | null> {
    const normalized = normalizeRecipientLocalPart(localPart);
    if (!normalized) return null;
    const [row] = await executor
        .select(addressColumns())
        .from(mailAddresses)
        .where(eq(mailAddresses.localPartHash, localPartHash(normalized)))
        .limit(1);
    return row ? toRow(row) : null;
}

/** Every address the user owns or created, blocked ones last. */
export async function listUserAddresses(
    userId: string,
): Promise<MailAddressRow[]> {
    const rows = await db
        .select(addressColumns())
        .from(mailAddresses)
        .where(
            sql`(${mailAddresses.namespaceUserId} = ${userId} or (${mailAddresses.kind} = 'secret' and ${mailAddresses.createdByUserId} = ${userId}))`,
        )
        .orderBy(asc(mailAddresses.createdAt));
    return rows.map(toRow);
}

async function loadAddress(
    executor: Executor,
    id: string,
): Promise<MailAddressRow | null> {
    const [row] = await executor
        .select(addressColumns())
        .from(mailAddresses)
        .where(eq(mailAddresses.id, id))
        .limit(1);
    return row ? toRow(row) : null;
}

function cleanLabel(label: string | null | undefined): string | null {
    return label?.trim() ? label.trim().slice(0, 100) : null;
}

async function insertSecretInTx(
    tx: Tx,
    input: {
        userId: string;
        baseAddressId: string;
        baseLocalPart: string;
        label: string | null;
    },
): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
        const created = await claimFirstFree(
            tx,
            [secretLocalPart(input.baseLocalPart)],
            {
                kind: "secret",
                namespaceUserId: input.userId,
                baseAddressId: input.baseAddressId,
                createdByUserId: input.userId,
                label: input.label ? encryptText(input.label) : null,
            },
        );
        if (created) return created.id;
    }
    throw new AppError(ErrorCode.INTERNAL_ERROR, "Address not created", 500);
}

/** One of the user's own active mailbox or folder addresses, or null. */
async function ownBaseAddress(
    executor: Executor,
    userId: string,
    addressId: string,
): Promise<MailAddressRow | null> {
    const [base] = await executor
        .select(addressColumns())
        .from(mailAddresses)
        .where(
            and(
                eq(mailAddresses.id, addressId),
                eq(mailAddresses.namespaceUserId, userId),
                inArray(mailAddresses.kind, ["mailbox", "folder"]),
                eq(mailAddresses.status, "active"),
            ),
        )
        .limit(1);
    return base ? toRow(base) : null;
}

/**
 * A new secret address extending one of the user's own personal addresses
 * (D3): anyone who knows it may send, so it is for a Gmail filter or a
 * correspondent, and revocable.
 */
export async function createSecretAddress(input: {
    userId: string;
    baseAddressId: string;
    label: string | null;
}): Promise<MailAddressRow> {
    const id = await db.transaction(async (tx) => {
        const base = await ownBaseAddress(
            tx,
            input.userId,
            input.baseAddressId,
        );
        if (!base) {
            throw new AppError(ErrorCode.NOT_FOUND, "Address not found", 404);
        }
        return insertSecretInTx(tx, {
            userId: input.userId,
            baseAddressId: base.id,
            baseLocalPart: base.localPart,
            label: cleanLabel(input.label),
        });
    });
    const row = await loadAddress(db, id);
    if (!row) {
        throw new AppError(
            ErrorCode.INTERNAL_ERROR,
            "Address not created",
            500,
        );
    }
    return row;
}

/**
 * Replaces one of the user's secret addresses with a new token for the same
 * target and label; the old one stops working at once.
 */
export async function rotateSecretAddress(input: {
    userId: string;
    addressId: string;
}): Promise<MailAddressRow> {
    const id = await db.transaction(async (tx) => {
        const [secret] = await tx
            .select(addressColumns())
            .from(mailAddresses)
            .where(
                and(
                    eq(mailAddresses.id, input.addressId),
                    eq(mailAddresses.kind, "secret"),
                    eq(mailAddresses.createdByUserId, input.userId),
                    ne(mailAddresses.status, "blocked"),
                ),
            )
            .for("update")
            .limit(1);
        const base = secret?.baseAddressId
            ? await ownBaseAddress(tx, input.userId, secret.baseAddressId)
            : null;
        if (!secret || !base) {
            throw new AppError(ErrorCode.NOT_FOUND, "Address not found", 404);
        }
        const now = new Date();
        await tx
            .update(mailAddresses)
            .set({ status: "blocked", blockedAt: now, updatedAt: now })
            .where(eq(mailAddresses.id, secret.id));
        return insertSecretInTx(tx, {
            userId: input.userId,
            baseAddressId: base.id,
            baseLocalPart: base.localPart,
            label: secret.label ? decryptText(secret.label) : null,
        });
    });
    const row = await loadAddress(db, id);
    if (!row) {
        throw new AppError(
            ErrorCode.INTERNAL_ERROR,
            "Address not created",
            500,
        );
    }
    return row;
}

/**
 * Blocks one of the user's secret addresses, or a secondary address of one
 * of their own folders, for good. A mailbox and a folder's current address
 * are not removable; an Organization folder's old addresses go through the
 * folder, by whoever may change it (`removeFolderSecondaryAddress`).
 */
export async function removeAddress(input: {
    userId: string;
    addressId: string;
}): Promise<void> {
    await db.transaction(async (tx) => {
        const now = new Date();
        const blocked = await tx
            .update(mailAddresses)
            .set({ status: "blocked", blockedAt: now, updatedAt: now })
            .where(
                and(
                    eq(mailAddresses.id, input.addressId),
                    ne(mailAddresses.status, "blocked"),
                    sql`((${mailAddresses.kind} = 'secret' and ${mailAddresses.createdByUserId} = ${input.userId}) or (${mailAddresses.kind} = 'folder' and not ${mailAddresses.primary} and ${mailAddresses.namespaceUserId} = ${input.userId}))`,
                ),
            )
            .returning({ id: mailAddresses.id });
        if (blocked.length === 0) {
            throw new AppError(ErrorCode.NOT_FOUND, "Address not found", 404);
        }
        await blockSecretsOfInTx(
            tx,
            blocked.map((row) => row.id),
        );
    });
}

/** Renames what the user calls one of their secret addresses. */
export async function labelAddress(input: {
    userId: string;
    addressId: string;
    label: string | null;
}): Promise<void> {
    const label = cleanLabel(input.label);
    const updated = await db
        .update(mailAddresses)
        .set({
            label: label ? encryptText(label) : null,
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(mailAddresses.id, input.addressId),
                eq(mailAddresses.kind, "secret"),
                eq(mailAddresses.createdByUserId, input.userId),
            ),
        )
        .returning({ id: mailAddresses.id });
    if (updated.length === 0) {
        throw new AppError(ErrorCode.NOT_FOUND, "Address not found", 404);
    }
}

/**
 * The live addresses of the folders `folderIds`, each folder's current one
 * first. The caller has checked the viewer may see the folders.
 */
export async function listFolderAddresses(
    folderIds: readonly string[],
): Promise<MailAddressRow[]> {
    if (folderIds.length === 0) return [];
    const rows = await db
        .select(addressColumns())
        .from(mailAddresses)
        .where(
            and(
                inArray(mailAddresses.folderId, [...folderIds]),
                eq(mailAddresses.kind, "folder"),
                ne(mailAddresses.status, "blocked"),
            ),
        )
        .orderBy(
            sql`${mailAddresses.primary} desc`,
            asc(mailAddresses.createdAt),
        );
    return rows.map(toRow);
}

/**
 * Blocks a folder's secondary address for good, and the secret addresses
 * extending it. The caller has checked the actor may change the folder.
 */
export async function removeFolderSecondaryAddress(input: {
    folderId: string;
    addressId: string;
}): Promise<void> {
    await db.transaction(async (tx) => {
        const now = new Date();
        const blocked = await tx
            .update(mailAddresses)
            .set({ status: "blocked", blockedAt: now, updatedAt: now })
            .where(
                and(
                    eq(mailAddresses.id, input.addressId),
                    eq(mailAddresses.folderId, input.folderId),
                    eq(mailAddresses.kind, "folder"),
                    eq(mailAddresses.primary, false),
                    ne(mailAddresses.status, "blocked"),
                ),
            )
            .returning({ id: mailAddresses.id });
        if (blocked.length === 0) {
            throw new AppError(ErrorCode.NOT_FOUND, "Address not found", 404);
        }
        await blockSecretsOfInTx(
            tx,
            blocked.map((row) => row.id),
        );
    });
}

/** Notes that mail came through an address. */
export async function touchAddress(
    executor: Executor,
    addressId: string,
    at: Date,
): Promise<void> {
    await executor
        .update(mailAddresses)
        .set({ lastReceivedAt: at })
        .where(eq(mailAddresses.id, addressId));
}

/**
 * Mailboxes for every eligible user and addresses for every custom folder
 * that lack one, oldest first. Idempotent, and safe when two processes run
 * it at once: the unique indexes keep one mailbox per user and one current
 * address per folder. Run at startup while mail is on.
 */
export async function backfillMailAddresses(): Promise<{
    mailboxes: number;
    folders: number;
}> {
    const counts = { mailboxes: 0, folders: 0 };
    if (!isMailEnabled()) return counts;
    const eligible = await db
        .select({ id: users.id })
        .from(users)
        .where(mailEligibleUserCondition())
        .orderBy(asc(users.createdAt));
    for (const user of eligible) {
        if (await findMailbox(user.id)) continue;
        if (await ensureMailbox(user.id)) counts.mailboxes++;
    }
    const folders = await db
        .select({ id: recordingFolders.id })
        .from(recordingFolders)
        .leftJoin(
            mailAddresses,
            and(
                eq(mailAddresses.folderId, recordingFolders.id),
                eq(mailAddresses.kind, "folder"),
                ne(mailAddresses.status, "blocked"),
            ),
        )
        .where(
            and(eq(recordingFolders.kind, "custom"), isNull(mailAddresses.id)),
        )
        .orderBy(asc(recordingFolders.createdAt));
    for (const folder of folders) {
        if (await ensureFolderAddress(folder.id)) counts.folders++;
    }
    await db
        .insert(instanceState)
        .values({
            key: "mail_address_backfill",
            value: new Date().toISOString(),
        })
        .onConflictDoUpdate({
            target: instanceState.key,
            set: { value: new Date().toISOString(), updatedAt: new Date() },
        });
    return counts;
}

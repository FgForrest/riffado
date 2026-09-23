"use client";

import { Merge, Pencil } from "lucide-react";
import { useRouter } from "next/navigation";
import { useExtracted } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { getApiErrorMessage } from "@/lib/api-errors";

interface MergeCandidate {
    id: string;
    displayName: string;
    primaryEmail: string | null;
    scope?: "personal" | "org";
}

interface PersonActionsProps {
    person: {
        id: string;
        displayName: string;
        primaryEmail: string | null;
        scope?: "personal" | "org";
    };
}

/**
 * Rename a person, or fold them into another.
 *
 * Shown only to whoever may change the person: their owner, or for an
 * Organization person the organization account, whose edits reach every
 * recording that names them.
 */
export function PersonActions({ person }: PersonActionsProps) {
    const i18n = useExtracted();
    const router = useRouter();
    const [renaming, setRenaming] = useState(false);
    const [merging, setMerging] = useState(false);
    const [name, setName] = useState(person.displayName);
    const [email, setEmail] = useState(person.primaryEmail ?? "");
    const [candidates, setCandidates] = useState<MergeCandidate[]>([]);
    const [targetId, setTargetId] = useState("");
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!merging) return;
        let cancelled = false;
        void fetch("/api/people")
            .then((response) =>
                response.ok ? response.json() : { people: [] },
            )
            .then((body: { people?: MergeCandidate[] }) => {
                if (cancelled) return;
                // An Organization person can only fold into another; a
                // private one into anyone its owner can see.
                setCandidates(
                    (body.people ?? []).filter(
                        (candidate) =>
                            candidate.id !== person.id &&
                            (person.scope !== "org" ||
                                candidate.scope === "org"),
                    ),
                );
            })
            .catch(() => {
                if (!cancelled) setCandidates([]);
            });
        return () => {
            cancelled = true;
        };
    }, [merging, person.id, person.scope]);

    async function rename() {
        setSaving(true);
        try {
            const response = await fetch(`/api/people/${person.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    displayName: name,
                    primaryEmail: email.trim() || null,
                }),
            });
            if (!response.ok) {
                toast.error(
                    await getApiErrorMessage(
                        response,
                        i18n("Could not save this person"),
                    ),
                );
                return;
            }
            setRenaming(false);
            router.refresh();
        } finally {
            setSaving(false);
        }
    }

    async function merge() {
        if (!targetId) return;
        setSaving(true);
        try {
            const response = await fetch(`/api/people/${person.id}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ mergeIntoId: targetId }),
            });
            if (!response.ok) {
                toast.error(
                    await getApiErrorMessage(
                        response,
                        i18n("Could not merge these people"),
                    ),
                );
                return;
            }
            const body = (await response.json()) as { person?: { id: string } };
            router.push(`/people/${body.person?.id ?? targetId}`);
            router.refresh();
        } finally {
            setSaving(false);
        }
    }

    return (
        <>
            <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                onClick={() => {
                    setName(person.displayName);
                    setEmail(person.primaryEmail ?? "");
                    setRenaming(true);
                }}
            >
                <Pencil className="mr-2 size-4" /> {i18n("Rename")}
            </Button>
            <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                onClick={() => {
                    setTargetId("");
                    setMerging(true);
                }}
            >
                <Merge className="mr-2 size-4" /> {i18n("Merge into…")}
            </Button>

            <Dialog open={renaming} onOpenChange={setRenaming}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>{i18n("Edit person")}</DialogTitle>
                        <DialogDescription>
                            {person.scope === "org"
                                ? i18n(
                                      "Changes apply to everyone and to every recording that names this person.",
                                  )
                                : i18n(
                                      "Changes apply to every recording that names this person.",
                                  )}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-2">
                        <Input
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            maxLength={200}
                            aria-label={i18n("Name")}
                        />
                        <Input
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                            maxLength={320}
                            type="email"
                            placeholder={i18n("Email (optional)")}
                            aria-label={i18n("Email")}
                        />
                    </div>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            disabled={saving}
                            onClick={() => setRenaming(false)}
                        >
                            {i18n("Cancel")}
                        </Button>
                        <Button
                            disabled={saving || !name.trim()}
                            onClick={() => void rename()}
                        >
                            {i18n("Save")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={merging} onOpenChange={setMerging}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>
                            {i18n("Merge {name} into…", {
                                name: person.displayName,
                            })}
                        </DialogTitle>
                        <DialogDescription>
                            {i18n(
                                "Every recording that names {name} will name the person you choose instead.",
                                { name: person.displayName },
                            )}
                        </DialogDescription>
                    </DialogHeader>
                    <select
                        value={targetId}
                        onChange={(event) => setTargetId(event.target.value)}
                        aria-label={i18n("Merge target")}
                        className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <option value="">{i18n("Choose a person")}</option>
                        {candidates.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                                {candidate.displayName}
                                {candidate.primaryEmail
                                    ? ` (${candidate.primaryEmail})`
                                    : ""}
                                {candidate.scope === "org"
                                    ? ` · ${i18n("Organization")}`
                                    : ""}
                            </option>
                        ))}
                    </select>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            disabled={saving}
                            onClick={() => setMerging(false)}
                        >
                            {i18n("Cancel")}
                        </Button>
                        <Button
                            disabled={saving || !targetId}
                            onClick={() => void merge()}
                        >
                            {i18n("Merge")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}

"use client";

import { Combine, ListChecks, Loader2, Play, Plus, X } from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useState } from "react";
import { HelpLink } from "@/components/help/help-button";
import {
    AssigneePicker,
    type SpeakerChoice,
} from "@/components/tasks/assignee-picker";
import { DueDateField, TaskTextInput } from "@/components/tasks/task-fields";
import type {
    RecordingTasksState,
    TaskRowChange,
} from "@/components/tasks/use-recording-tasks";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import type { TaskUpdateView, TaskView } from "@/lib/tasks/tasks";
import { cn } from "@/lib/utils";

/**
 * The proposed tasks of a recording, the way Learn's findings are: a link
 * with how many wait, opening a review to tick, correct or merge them and
 * the follow-ups heard about earlier tasks, then accept. Unticking is the
 * one way to say no: it stays undoable until the review is accepted.
 */
export function TaskReviewLink({
    state,
    speakers,
    organizationOnly,
    allowAdd = true,
    onPlay,
}: {
    state: RecordingTasksState;
    /** People attributed to the recording's speakers, offered first. */
    speakers: readonly SpeakerChoice[];
    /** The Organization view: assignees come from the Organization only. */
    organizationOnly: boolean;
    /** Offer adding tasks by hand; not without a summary they would die with. */
    allowAdd?: boolean;
    onPlay?: (startMs: number) => void;
}) {
    const i18n = useExtracted();
    const [open, setOpen] = useState(false);
    const [merging, setMerging] = useState<string[] | null>(null);
    const { data, reviewing, waiting } = state;

    // Nothing left to review: the dialog has done its job.
    useEffect(() => {
        if (!reviewing) {
            setOpen(false);
            setMerging(null);
        }
    }, [reviewing]);

    if (!data || !reviewing) return null;

    /** Select or unselect a proposal to merge, keeping the selection order. */
    const toggleMerging = (id: string) =>
        setMerging((current) => {
            const selected = current ?? [];
            return selected.includes(id)
                ? selected.filter((other) => other !== id)
                : [...selected, id];
        });

    const merge = async () => {
        if (merging && (await state.merge(merging))) setMerging(null);
    };

    const ticked =
        data.proposals.filter((task) => task.ticked).length +
        data.updates.filter((update) => update.ticked).length;

    return (
        <>
            <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-auto gap-1 px-0 text-sm font-medium hover:bg-transparent hover:text-primary"
                onClick={() => setOpen(true)}
            >
                <ListChecks className="size-4" />
                {i18n("Review tasks ({count})", { count: String(waiting) })}
            </Button>
            <Dialog
                open={open}
                onOpenChange={(next) => {
                    setOpen(next);
                    if (!next) setMerging(null);
                }}
            >
                <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl lg:max-w-3xl">
                    <DialogHeader className="border-b px-6 pt-6 pb-4 pr-12">
                        <DialogTitle className="flex items-center gap-2">
                            {i18n("Proposed tasks")}
                            <HelpLink
                                topic="tasks.review"
                                label={i18n("reviewing proposed tasks")}
                            />
                        </DialogTitle>
                        <DialogDescription>
                            {merging
                                ? i18n(
                                      "Select the tasks that are one. They become the first one selected.",
                                  )
                                : i18n(
                                      "What the summary found to do. Untick what is not a task, correct who and when, then accept. Unticked ones are not proposed again.",
                                  )}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="min-h-0 flex-1 space-y-8 overflow-y-auto px-6 py-5">
                        {(data.proposals.length > 0 || allowAdd) && (
                            <section className="space-y-2">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <SectionTitle
                                        title={i18n("Tasks")}
                                        count={data.proposals.length}
                                    />
                                    <div className="flex items-center gap-2">
                                        {merging ? (
                                            <>
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    disabled={
                                                        merging.length < 2
                                                    }
                                                    onClick={() => void merge()}
                                                >
                                                    <Combine className="mr-1 size-3.5" />
                                                    {i18n(
                                                        "Merge {count, plural, one {# task} other {# tasks}}",
                                                        {
                                                            count: merging.length,
                                                        },
                                                    )}
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    onClick={() =>
                                                        setMerging(null)
                                                    }
                                                >
                                                    <X className="size-3.5" />
                                                    <span className="sr-only">
                                                        {i18n("Cancel merging")}
                                                    </span>
                                                </Button>
                                            </>
                                        ) : (
                                            data.proposals.length > 1 && (
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    onClick={() =>
                                                        setMerging([])
                                                    }
                                                >
                                                    <Combine className="mr-1 size-3.5" />
                                                    {i18n("Merge…")}
                                                </Button>
                                            )
                                        )}
                                    </div>
                                </div>
                                <ul className="space-y-2">
                                    {data.proposals.map((task) => (
                                        <ProposalRow
                                            key={task.id}
                                            task={task}
                                            speakers={speakers}
                                            organizationOnly={organizationOnly}
                                            onPlay={onPlay}
                                            selection={
                                                merging
                                                    ? {
                                                          selected:
                                                              merging.includes(
                                                                  task.id,
                                                              ),
                                                          onToggle: () =>
                                                              toggleMerging(
                                                                  task.id,
                                                              ),
                                                      }
                                                    : null
                                            }
                                            onChange={(change, optimistic) =>
                                                state.update(
                                                    task,
                                                    change,
                                                    optimistic,
                                                )
                                            }
                                        />
                                    ))}
                                </ul>
                                {allowAdd && !merging && (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() =>
                                            void state.add("proposed")
                                        }
                                    >
                                        <Plus className="mr-1 size-3.5" />
                                        {i18n("Add task")}
                                    </Button>
                                )}
                            </section>
                        )}
                        {data.updates.length > 0 && (
                            <section className="space-y-2">
                                <SectionTitle
                                    title={i18n("Heard about earlier tasks")}
                                    count={data.updates.length}
                                />
                                <ul className="space-y-2">
                                    {data.updates.map((update) => (
                                        <UpdateRow
                                            key={update.id}
                                            update={update}
                                            onPlay={onPlay}
                                            onToggle={(next) =>
                                                state.tickUpdate(update, next)
                                            }
                                        />
                                    ))}
                                </ul>
                            </section>
                        )}
                    </div>

                    <DialogFooter className="border-t px-6 py-4 sm:items-center sm:justify-between">
                        <p className="text-sm text-muted-foreground">
                            {i18n("{ticked} of {count} will be accepted", {
                                ticked: String(ticked),
                                count: String(waiting),
                            })}
                        </p>
                        <div className="flex flex-col-reverse gap-2 sm:flex-row">
                            <Button
                                variant="outline"
                                onClick={() => setOpen(false)}
                            >
                                {i18n("Save and continue later")}
                            </Button>
                            <Button
                                disabled={state.accepting || merging !== null}
                                onClick={() => void state.accept()}
                            >
                                {state.accepting && (
                                    <Loader2 className="size-4 animate-spin" />
                                )}
                                {i18n("Accept tasks")}
                            </Button>
                        </div>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}

/** A section of the review: what it holds, and how many. */
function SectionTitle({ title, count }: { title: string; count: number }) {
    return (
        <h3 className="flex items-baseline gap-2 text-sm font-semibold">
            {title}
            <span className="text-xs font-normal tabular-nums text-muted-foreground">
                {count}
            </span>
        </h3>
    );
}

function ProposalRow({
    task,
    speakers,
    organizationOnly,
    onPlay,
    selection,
    onChange,
}: {
    task: TaskView;
    speakers: readonly SpeakerChoice[];
    organizationOnly: boolean;
    onPlay?: (startMs: number) => void;
    selection: { selected: boolean; onToggle: () => void } | null;
    onChange: TaskRowChange;
}) {
    const i18n = useExtracted();

    return (
        <li
            className={cn(
                "-mx-2 flex items-start gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted/50",
                !task.ticked && !selection && "opacity-60",
                selection?.selected && "bg-primary/5 ring-2 ring-primary",
            )}
        >
            {selection ? (
                <input
                    type="checkbox"
                    className="mt-1.5 size-4 shrink-0 accent-primary"
                    checked={selection.selected}
                    onChange={selection.onToggle}
                    aria-label={i18n("Select to merge")}
                />
            ) : (
                <input
                    type="checkbox"
                    className="mt-1.5 size-4 shrink-0"
                    checked={task.ticked}
                    onChange={(event) =>
                        onChange(
                            { ticked: event.target.checked },
                            { ticked: event.target.checked },
                        )
                    }
                    aria-label={i18n("Keep this task")}
                />
            )}
            <div className="min-w-0 flex-1 space-y-1.5">
                <TaskTextInput
                    text={task.text}
                    onSave={(text) => onChange({ text }, { text })}
                    className="w-full py-0.5"
                />
                <div className="flex flex-wrap items-center gap-2 px-1">
                    <AssigneePicker
                        value={task.assignee}
                        hint={task.assigneeHint}
                        check={task.assigneeCheck}
                        speakers={speakers}
                        organizationOnly={organizationOnly}
                        onChange={(person) =>
                            onChange(
                                { assigneePersonId: person?.personId ?? null },
                                {
                                    assignee: person,
                                    assigneeHint: null,
                                    assigneeCheck: false,
                                },
                            )
                        }
                    />
                    <DueDateField
                        value={task.dueDate}
                        phrase={task.duePhrase}
                        overdue={false}
                        disabled={false}
                        onChange={(dueDate) =>
                            onChange({ dueDate }, { dueDate })
                        }
                    />
                    {task.evidenceStartMs !== null && onPlay && (
                        <button
                            type="button"
                            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
                            title={task.quote ?? undefined}
                            onClick={() =>
                                onPlay(task.evidenceStartMs as number)
                            }
                        >
                            <Play className="size-3" />
                            {i18n("Where it was said")}
                        </button>
                    )}
                    {task.quote && (
                        <span className="min-w-0 truncate text-xs italic text-muted-foreground">
                            “{task.quote}”
                        </span>
                    )}
                    <ProvenanceNote provenance={task.evidenceProvenance} />
                </div>
            </div>
        </li>
    );
}

/** Why a proposal read in a mail is worth a second look. */
function ProvenanceNote({
    provenance,
}: {
    provenance: TaskView["evidenceProvenance"];
}) {
    const i18n = useExtracted();
    if (!provenance) return null;
    return (
        <span className="text-xs text-amber-700 dark:text-amber-400">
            {provenance === "quoted"
                ? i18n("From an earlier message quoted in the mail")
                : provenance === "unverified"
                  ? i18n("From a sender nothing verified")
                  : i18n("Its words were not found in the mail")}
        </span>
    );
}

function UpdateRow({
    update,
    onPlay,
    onToggle,
}: {
    update: TaskUpdateView;
    onPlay?: (startMs: number) => void;
    onToggle: (ticked: boolean) => void;
}) {
    const i18n = useExtracted();
    return (
        <li
            className={cn(
                "-mx-2 flex items-start gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted/50",
                !update.ticked && "opacity-60",
            )}
        >
            <input
                type="checkbox"
                className="mt-1 size-4 shrink-0"
                checked={update.ticked}
                onChange={(event) => onToggle(event.target.checked)}
                aria-label={i18n("Apply this")}
            />
            <div className="min-w-0 flex-1">
                <p>
                    <span className="font-medium">
                        {update.kind === "done"
                            ? i18n("Mark done:")
                            : i18n("Move due date to {date}:", {
                                  date: update.dueDate ?? "",
                              })}
                    </span>{" "}
                    {update.task.text}
                </p>
                <p className="text-xs text-muted-foreground">
                    {update.task.assigneeName
                        ? i18n("{name}, from {recording}", {
                              name: update.task.assigneeName,
                              recording: update.task.recordingTitle,
                          })
                        : i18n("From {recording}", {
                              recording: update.task.recordingTitle,
                          })}
                    {update.quote && <> · “{update.quote}”</>}
                </p>
                <ProvenanceNote provenance={update.evidenceProvenance} />
            </div>
            {update.evidenceStartMs !== null && onPlay && (
                <button
                    type="button"
                    className="mt-1 text-muted-foreground hover:text-primary"
                    onClick={() => onPlay(update.evidenceStartMs as number)}
                    aria-label={i18n("Where it was said")}
                >
                    <Play className="size-3.5" />
                </button>
            )}
        </li>
    );
}

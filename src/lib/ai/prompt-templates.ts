/**
 * Editable prompt templates, shared by summary and title generation.
 *
 * Every user starts with the built-in presets, seeded under the preset's own
 * id so that stored references ("general", "meeting-notes", the saved default,
 * the auto-summary choice) keep resolving. A seeded template stores null for
 * whatever the user has not changed: an unedited template keeps following the
 * built-in text and its localized name as they improve in later releases,
 * rather than freezing the copy it was seeded with.
 *
 * Everything here is pure, so the settings UI and the generators share one
 * reading of the stored value.
 */

export interface PromptTemplate {
    id: string;
    /** null: the built-in preset's name, localized at display time. */
    name: string | null;
    /** null: the built-in preset's current text. Valid only on a preset id. */
    prompt: string | null;
    createdAt: string;
}

export interface TemplateConfiguration {
    /** Id of the default template. */
    selectedPrompt: string;
    templates: PromptTemplate[];
}

/** A user-written prompt as stored before the built-ins became editable. */
export interface LegacyCustomPrompt {
    id: string;
    name: string;
    prompt: string;
    createdAt: string;
}

/** The built-in presets of one kind of template. */
export interface TemplateKind<P extends string = string> {
    presets: Readonly<Record<P, { prompt: string }>>;
    /** Used when the user's own list has nothing to offer. */
    fallbackId: P;
}

/** Seeded templates carry no creation time of their own. */
const SEEDED_AT = new Date(0).toISOString();

export function isPresetId<P extends string>(
    kind: TemplateKind<P>,
    id: string,
): id is P {
    return Object.hasOwn(kind.presets, id);
}

function presetIds<P extends string>(kind: TemplateKind<P>): P[] {
    return Object.keys(kind.presets) as P[];
}

/** A built-in preset as an unedited template. */
export function seedTemplate(id: string): PromptTemplate {
    return { id, name: null, prompt: null, createdAt: SEEDED_AT };
}

export function defaultTemplateConfig(
    kind: TemplateKind,
): TemplateConfiguration {
    return {
        selectedPrompt: kind.fallbackId,
        templates: presetIds(kind).map(seedTemplate),
    };
}

/**
 * Read a stored (decrypted) value as a template list.
 *
 * Seeding happens here, on read, rather than in a migration: the columns are
 * encrypted, so SQL cannot rewrite them, and a user who never opens the
 * settings has nothing to persist. A value without `templates` -- no value at
 * all, or one saved before templates existed -- reads as the built-ins
 * followed by the custom prompts it had. Once a `templates` list is saved it
 * is taken as it stands, so a template the user deleted stays deleted.
 */
export function normalizeTemplateConfig(
    raw: unknown,
    kind: TemplateKind,
): TemplateConfiguration {
    const seeded = defaultTemplateConfig(kind);
    if (typeof raw !== "object" || raw === null) return seeded;
    const stored = raw as {
        selectedPrompt?: unknown;
        templates?: unknown;
        customPrompts?: unknown;
    };
    const templates = Array.isArray(stored.templates)
        ? (stored.templates as PromptTemplate[])
        : [
              ...seeded.templates,
              ...(Array.isArray(stored.customPrompts)
                  ? (stored.customPrompts as LegacyCustomPrompt[])
                  : []),
          ];
    const selected = stored.selectedPrompt;
    return {
        selectedPrompt:
            typeof selected === "string" &&
            templates.some((t) => t.id === selected)
                ? selected
                : (templates[0]?.id ?? kind.fallbackId),
        templates,
    };
}

/** The template's text: its own, or the built-in one it still follows. */
export function templatePrompt(
    template: PromptTemplate,
    kind: TemplateKind,
): string {
    if (template.prompt !== null) return template.prompt;
    return isPresetId(kind, template.id)
        ? kind.presets[template.id].prompt
        : "";
}

/**
 * The prompt to generate with, and the id it actually came from.
 *
 * A missing id -- a template deleted since the request was made, or a stale
 * auto-summary choice -- falls back to the user's own default template, and
 * only then to the built-in fallback. `id` differs from the requested one in
 * that case, so the caller can say so instead of silently using another
 * template.
 */
export function resolveTemplate(
    config: TemplateConfiguration,
    requestedId: string | null | undefined,
    kind: TemplateKind,
): { id: string; prompt: string } {
    for (const id of [requestedId, config.selectedPrompt]) {
        const template = id && config.templates.find((t) => t.id === id);
        if (template) {
            const prompt = templatePrompt(template, kind);
            if (prompt.trim()) return { id: template.id, prompt };
        }
    }
    return {
        id: kind.fallbackId,
        prompt: kind.presets[kind.fallbackId as keyof typeof kind.presets]
            .prompt,
    };
}

/** Built-in presets the user has deleted, in their original order. */
export function missingPresetIds(
    config: TemplateConfiguration,
    kind: TemplateKind,
): string[] {
    return presetIds(kind).filter(
        (id) => !config.templates.some((t) => t.id === id),
    );
}

/** Puts the deleted built-ins back, unedited, at the end of the list. */
export function restoreMissingPresets(
    config: TemplateConfiguration,
    kind: TemplateKind,
): TemplateConfiguration {
    return {
        ...config,
        templates: [
            ...config.templates,
            ...missingPresetIds(config, kind).map(seedTemplate),
        ],
    };
}

export interface TemplateEdit {
    /** Absent for a new template. */
    id?: string;
    name: string;
    prompt: string;
}

/**
 * Apply an edit from the dialog.
 *
 * For a built-in, text equal to the built-in text is stored as null, and so
 * is a name equal to `builtinName` (the localized name the dialog showed):
 * storing either verbatim would pin the template to today's version.
 */
export function saveTemplate(
    config: TemplateConfiguration,
    edit: TemplateEdit,
    kind: TemplateKind,
    options: { newId: () => string; builtinName?: string },
): TemplateConfiguration {
    const name = edit.name.trim();
    const prompt = edit.prompt.trim();
    const existing = edit.id
        ? config.templates.find((t) => t.id === edit.id)
        : undefined;
    if (!existing) {
        const created: PromptTemplate = {
            id: options.newId(),
            name,
            prompt,
            createdAt: new Date().toISOString(),
        };
        return { ...config, templates: [...config.templates, created] };
    }
    const builtin = isPresetId(kind, existing.id);
    const updated: PromptTemplate = {
        ...existing,
        name: builtin && name === options.builtinName ? null : name,
        prompt:
            builtin && prompt === kind.presets[existing.id].prompt.trim()
                ? null
                : prompt,
    };
    return {
        ...config,
        templates: config.templates.map((t) =>
            t.id === existing.id ? updated : t,
        ),
    };
}

/**
 * Remove a template. The default role cannot be left pointing at nothing,
 * so it moves to the first remaining template. Refuses to remove the last
 * one: generation always needs a template.
 */
export function deleteTemplate(
    config: TemplateConfiguration,
    id: string,
): TemplateConfiguration {
    const templates = config.templates.filter((t) => t.id !== id);
    if (templates.length === 0) return config;
    return {
        selectedPrompt:
            config.selectedPrompt === id
                ? templates[0].id
                : config.selectedPrompt,
        templates,
    };
}

function isNullableString(value: unknown): value is string | null {
    return value === null || typeof value === "string";
}

/**
 * Validate an untrusted payload before it is encrypted and stored. Accepts
 * the template shape and the legacy `customPrompts` one. Shape only -- this
 * is the user's own settings data -- but a malformed value would otherwise
 * be encrypted silently and surface as a broken list on the next read.
 */
export function isValidTemplateConfig(
    value: unknown,
    kind: TemplateKind,
): boolean {
    if (typeof value !== "object" || value === null) return false;
    const config = value as Record<string, unknown>;
    if (typeof config.selectedPrompt !== "string") return false;

    if (config.templates !== undefined) {
        if (!Array.isArray(config.templates)) return false;
        const ids = new Set<string>();
        for (const t of config.templates as unknown[]) {
            if (typeof t !== "object" || t === null) return false;
            const entry = t as Record<string, unknown>;
            if (typeof entry.id !== "string" || entry.id === "") return false;
            if (ids.has(entry.id)) return false;
            ids.add(entry.id);
            if (!isNullableString(entry.name)) return false;
            if (!isNullableString(entry.prompt)) return false;
            if (entry.prompt === null && !isPresetId(kind, entry.id)) {
                return false;
            }
            if (entry.name === null && !isPresetId(kind, entry.id)) {
                return false;
            }
            if (typeof entry.createdAt !== "string") return false;
        }
        return true;
    }

    if (!Array.isArray(config.customPrompts)) return false;
    return config.customPrompts.every(
        (p) =>
            typeof p === "object" &&
            p !== null &&
            typeof (p as Record<string, unknown>).id === "string" &&
            typeof (p as Record<string, unknown>).name === "string" &&
            typeof (p as Record<string, unknown>).prompt === "string" &&
            typeof (p as Record<string, unknown>).createdAt === "string",
    );
}

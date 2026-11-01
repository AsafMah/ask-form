// Pure logic for ask_form: validate the agent's request, build the elicitation schema the host
// renders, and turn whatever the host returns into a truthful result for the agent. Nothing here
// touches the session, so every branch is testable without a host.

export const LIMITS = {
    contextChars: 20000,
    questions: 10,
    questionChars: 300,
    descriptionChars: 500,
    options: 25,
    optionChars: 120,
    textChars: 5000,
};

const ID = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const RESERVED = new Set(["comment"]);
const OTHER_SUFFIX = "__other";

const STRING_FORMATS = { email: "email", url: "uri", date: "date", datetime: "date-time" };
export const TYPES = [
    "choice", "multi_choice", "boolean", "text", "number", "integer",
    "email", "url", "date", "datetime",
];

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isText = (v) => typeof v === "string" && v.trim().length > 0;

// ---------------------------------------------------------------------------- validation

function checkOptions(q, where, errors) {
    if (!Array.isArray(q.options) || q.options.length < 2) {
        errors.push(`${where}: "options" must list at least 2 strings for type "${q.type}".`);
        return;
    }
    if (q.options.length > LIMITS.options) errors.push(`${where}: at most ${LIMITS.options} options.`);
    const seen = new Set();
    q.options.forEach((o, i) => {
        if (!isText(o)) errors.push(`${where}: options[${i}] must be a non-empty string.`);
        else if (o.length > LIMITS.optionChars) errors.push(`${where}: options[${i}] exceeds ${LIMITS.optionChars} chars.`);
        else if (seen.has(o)) errors.push(`${where}: duplicate option "${o}".`);
        seen.add(o);
    });
}

function checkRange(q, lo, hi, where, errors) {
    const a = q[lo], b = q[hi];
    for (const [k, v] of [[lo, a], [hi, b]]) {
        if (v !== undefined && !Number.isFinite(v)) errors.push(`${where}: "${k}" must be a number.`);
    }
    if (Number.isFinite(a) && Number.isFinite(b) && a > b) errors.push(`${where}: "${lo}" is greater than "${hi}".`);
}

function checkDefault(q, where, errors) {
    const d = q.default;
    if (d === undefined) return;
    const bad = (why) => errors.push(`${where}: "default" ${why}.`);
    switch (q.type) {
        case "choice":
            if (!Array.isArray(q.options) || !q.options.includes(d)) bad("must be one of the options");
            break;
        case "multi_choice":
            if (!Array.isArray(d) || !d.every((x) => Array.isArray(q.options) && q.options.includes(x))) {
                bad("must be an array of options");
            }
            break;
        case "boolean":
            if (typeof d !== "boolean") bad("must be true or false");
            break;
        case "number":
        case "integer":
            if (!Number.isFinite(d) || (q.type === "integer" && !Number.isInteger(d))) bad(`must be a${q.type === "integer" ? "n integer" : " number"}`);
            else if ((Number.isFinite(q.min) && d < q.min) || (Number.isFinite(q.max) && d > q.max)) bad("is outside min/max");
            break;
        default:
            if (typeof d !== "string") bad("must be a string");
    }
}

// Returns { errors } or { form } where form is the normalised request.
export function validateRequest(args) {
    const errors = [];
    if (!isObject(args)) return { errors: ["Arguments must be an object with \"context\" and \"questions\"."] };

    const context = args.context;
    if (!isText(context)) errors.push("\"context\" is required: the explanation the user needs to answer, as markdown.");
    else if (context.length > LIMITS.contextChars) errors.push(`"context" exceeds ${LIMITS.contextChars} chars; summarise it.`);

    const qs = args.questions;
    if (!Array.isArray(qs) || qs.length === 0) {
        errors.push("\"questions\" must be a non-empty array.");
        return { errors };
    }
    if (qs.length > LIMITS.questions) errors.push(`At most ${LIMITS.questions} questions per form; split into rounds.`);

    const ids = new Set();
    qs.forEach((q, i) => {
        const where = `questions[${i}]`;
        if (!isObject(q)) { errors.push(`${where} must be an object.`); return; }
        if (typeof q.id !== "string" || !ID.test(q.id) || q.id.endsWith(OTHER_SUFFIX) || RESERVED.has(q.id)) {
            errors.push(`${where}: "id" must match ${ID} and not be "comment" or end in "${OTHER_SUFFIX}".`);
        } else if (ids.has(q.id)) errors.push(`${where}: duplicate id "${q.id}".`);
        else ids.add(q.id);

        if (!isText(q.question)) errors.push(`${where}: "question" is required.`);
        else if (q.question.length > LIMITS.questionChars) errors.push(`${where}: "question" exceeds ${LIMITS.questionChars} chars; move detail into "context".`);
        if (q.description !== undefined && (typeof q.description !== "string" || q.description.length > LIMITS.descriptionChars)) {
            errors.push(`${where}: "description" must be a string of at most ${LIMITS.descriptionChars} chars.`);
        }
        if (q.required !== undefined && typeof q.required !== "boolean") errors.push(`${where}: "required" must be a boolean.`);
        if (q.allowOther !== undefined && typeof q.allowOther !== "boolean") errors.push(`${where}: "allowOther" must be a boolean.`);

        if (!TYPES.includes(q.type)) {
            errors.push(`${where}: "type" must be one of ${TYPES.join(", ")}.`);
            return;
        }
        if (q.type === "choice" || q.type === "multi_choice") checkOptions(q, where, errors);
        else if (q.options !== undefined) errors.push(`${where}: "options" only applies to choice and multi_choice.`);
        if (q.allowOther && q.type !== "choice" && q.type !== "multi_choice") {
            errors.push(`${where}: "allowOther" only applies to choice and multi_choice.`);
        }
        if (q.type === "number" || q.type === "integer") checkRange(q, "min", "max", where, errors);
        if (q.type === "text") {
            checkRange(q, "minLength", "maxLength", where, errors);
            if (Number.isFinite(q.maxLength) && q.maxLength > LIMITS.textChars) errors.push(`${where}: "maxLength" above ${LIMITS.textChars}.`);
        }
        if (q.type === "multi_choice") checkRange(q, "minItems", "maxItems", where, errors);
        checkDefault(q, where, errors);
    });

    if (args.allowComment !== undefined && typeof args.allowComment !== "boolean") {
        errors.push("\"allowComment\" must be a boolean.");
    }
    if (errors.length) return { errors };
    return { form: { context, questions: qs, allowComment: args.allowComment !== false } };
}

// ---------------------------------------------------------------------------- schema

function fieldFor(q) {
    const base = { title: q.question, ...(q.description ? { description: q.description } : {}) };
    const withDefault = (field) => (q.default === undefined ? field : { ...field, default: q.default });
    switch (q.type) {
        case "choice":
            return withDefault({ type: "string", ...base, enum: [...q.options] });
        case "multi_choice":
            return withDefault({
                type: "array", ...base,
                ...(Number.isFinite(q.minItems) ? { minItems: q.minItems } : {}),
                ...(Number.isFinite(q.maxItems) ? { maxItems: q.maxItems } : {}),
                items: { type: "string", enum: [...q.options] },
            });
        case "boolean":
            return withDefault({ type: "boolean", ...base });
        case "number":
        case "integer":
            return withDefault({
                type: q.type, ...base,
                ...(Number.isFinite(q.min) ? { minimum: q.min } : {}),
                ...(Number.isFinite(q.max) ? { maximum: q.max } : {}),
            });
        case "text":
            return withDefault({
                type: "string", ...base,
                ...(Number.isFinite(q.minLength) ? { minLength: q.minLength } : {}),
                maxLength: Number.isFinite(q.maxLength) ? q.maxLength : LIMITS.textChars,
            });
        default:
            return withDefault({ type: "string", ...base, format: STRING_FORMATS[q.type] });
    }
}

export function buildElicitation(form) {
    const properties = {};
    const required = [];
    for (const q of form.questions) {
        properties[q.id] = fieldFor(q);
        if (q.required) required.push(q.id);
        // Elicitation fields cannot combine a list with free text, so "other" is its own field.
        if (q.allowOther) {
            properties[q.id + OTHER_SUFFIX] = {
                type: "string",
                title: `Other answer for: ${q.question}`.slice(0, LIMITS.questionChars + 30),
                description: "Optional. Fill this in if none of the options fit.",
                maxLength: LIMITS.textChars,
            };
        }
    }
    if (form.allowComment) {
        properties.comment = {
            type: "string",
            title: "Anything else?",
            description: "Optional free-text note for the agent.",
            maxLength: LIMITS.textChars,
        };
    }
    return {
        // The context is the message itself, so the explanation is inside the dialog the user
        // answers rather than in a chat message the question panel may hide.
        message: form.context,
        requestedSchema: { type: "object", properties, ...(required.length ? { required } : {}) },
    };
}

// ---------------------------------------------------------------------------- answers

function readValue(q, raw) {
    // The host's own structured ask_user notes that a boolean can come back as a string, so mild
    // coercion is accepted and anything else is reported rather than guessed.
    switch (q.type) {
        case "choice":
            return typeof raw === "string" && q.options.includes(raw) ? { value: raw } : { invalid: true };
        case "multi_choice": {
            const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : null;
            return list && list.every((x) => q.options.includes(x)) ? { value: list } : { invalid: true };
        }
        case "boolean":
            if (typeof raw === "boolean") return { value: raw };
            if (raw === "true" || raw === "false") return { value: raw === "true" };
            return { invalid: true };
        case "number":
        case "integer": {
            const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
            if (!Number.isFinite(n) || (q.type === "integer" && !Number.isInteger(n))) return { invalid: true };
            return { value: n };
        }
        default:
            return typeof raw === "string" ? { value: raw } : { invalid: true };
    }
}

const isEmpty = (v) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

export function interpretAccept(form, content) {
    const values = isObject(content) ? content : {};
    const answers = {};
    const unanswered = [];
    const invalid = {};
    for (const q of form.questions) {
        const raw = values[q.id];
        const other = values[q.id + OTHER_SUFFIX];
        if (q.allowOther && typeof other === "string" && other.trim()) answers[q.id + OTHER_SUFFIX] = other;
        if (isEmpty(raw)) {
            if (!(q.id + OTHER_SUFFIX in answers)) unanswered.push(q.id);
            continue;
        }
        const read = readValue(q, raw);
        if (read.invalid) invalid[q.id] = raw;
        else answers[q.id] = read.value;
    }
    const comment = typeof values.comment === "string" && values.comment.trim() ? values.comment : undefined;
    return { answers, unanswered, invalid, comment };
}

// ---------------------------------------------------------------------------- waiting

// Neither ui.elicitation nor the dialog it opens accepts a signal, so this ends only the wait;
// the dialog may stay on screen and still be answered. Callers must treat that answer as late.
export function raceDeadline(pending, { signal, timeoutMs }) {
    let release = () => {};
    const ended = new Promise((resolve) => {
        const cleanups = [];
        if (signal) {
            const onAbort = () => resolve({ ended: "aborted" });
            if (signal.aborted) return onAbort();
            signal.addEventListener("abort", onAbort, { once: true });
            cleanups.push(() => signal.removeEventListener("abort", onAbort));
        }
        // Node fires a delay above 2^31-1 ms after 1 ms, which would turn a long timeout into none.
        const ms = Math.min(timeoutMs, 2 ** 31 - 1);
        if (ms > 0) {
            const timer = setTimeout(() => resolve({ ended: "timeout" }), ms);
            timer.unref?.();
            cleanups.push(() => clearTimeout(timer));
        }
        release = () => cleanups.forEach((fn) => fn());
    });
    return Promise.race([
        pending.then((result) => ({ result }), (error) => ({ error })),
        ended,
    ]).finally(() => release());
}

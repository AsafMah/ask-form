// ask_form — ask the user several related, typed questions in one form, with the explanation
// they depend on shown inside the form.
//
// The app's built-in ask_user takes one question with text choices, and the chat text written
// before it is not always visible while the question is open. The runtime can render multi-field
// typed forms (`session.ui.elicitation`); this extension exposes that to the agent as a tool.
//
// Companion to `advisor`, `self-learn` and `clip`. See README.md.

import { joinSession } from "@github/copilot-sdk/extension";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { buildElicitation, interpretAccept, raceDeadline, validateRequest, LIMITS, TYPES } from "./form.mjs";

const CONFIG_DIR = process.env.COPILOT_CONFIG_DIR || join(homedir(), ".copilot");

// The host aborted a tool call waiting on a dialog after exactly 1800 s (self-learn, session
// 8282634f). Ending the wait a little earlier lets the agent receive a truthful timeout result
// instead of an abort it never sees explained.
const HOST_TOOL_LIMIT_MS = 1_800_000;
const MAX_TIMEOUT_MS = HOST_TOOL_LIMIT_MS - 10_000;

const DEFAULTS = {
    enabled: true,
    timeoutMs: 25 * 60_000,
    debugLog: join(CONFIG_DIR, "logs", "ask-form.log"),
};

function loadConfig() {
    const candidates = [process.env.COPILOT_ASK_FORM_CONFIG, join(CONFIG_DIR, "ask-form.json")].filter(Boolean);
    for (const path of candidates) {
        try {
            if (!existsSync(path)) continue;
            return { ...DEFAULTS, ...JSON.parse(readFileSync(path, "utf8")), _configPath: path };
        } catch {
            // A broken config file must not stop the extension from loading.
        }
    }
    return { ...DEFAULTS, _configPath: null };
}

const config = loadConfig();
const timeoutMs = Math.min(Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULTS.timeoutMs, MAX_TIMEOUT_MS);

function debug(message) {
    if (!config.debugLog) return;
    try {
        mkdirSync(dirname(config.debugLog), { recursive: true });
        appendFileSync(config.debugLog, `[${new Date().toISOString()}] ${message}\n`);
    } catch {
        // Tracing must never break a form.
    }
}

// Only one form at a time: parallel calls would stack dialogs whose answers the user cannot
// tell apart.
let openCall = null;

const result = (resultType, text) => ({ textResultForLlm: text, resultType });

const NOT_CONSENT =
    "No answer was given. Do not treat this as approval or as any particular choice, and do not " +
    "carry out actions that depended on these answers.";

async function askForm(session, args, invocation = {}) {
    if (!config.enabled) return result("failure", "ask_form is disabled by configuration. Use ask_user instead.");
    if (invocation.agentId) {
        return result("rejected",
            "ask_form is only available to the main agent. Return the questions to the main agent instead.");
    }
    if (!session.capabilities?.ui?.elicitation) {
        return result("failure",
            "This host cannot show forms (no elicitation support), so nothing was shown to the user. " +
            "Use ask_user instead and put the needed context inside the question text.");
    }

    const { errors, form } = validateRequest(args);
    if (errors) {
        return result("failure", `ask_form request is invalid; nothing was shown to the user. Fix and retry:\n- ${errors.join("\n- ")}`);
    }
    if (openCall) {
        return result("failure",
            "Another ask_form is already waiting for the user. Wait for its result instead of opening a second form.");
    }

    const callId = invocation.toolCallId ?? "unknown";
    openCall = callId;
    const started = Date.now();
    debug(`${callId}: form opened (${form.questions.length} question(s), context ${form.context.length} chars)`);

    const pending = Promise.resolve().then(() => session.ui.elicitation(buildElicitation(form)));
    let outcome;
    try {
        outcome = await raceDeadline(pending, { signal: invocation.signal, timeoutMs });
    } finally {
        openCall = null;
    }
    const waited = Math.round((Date.now() - started) / 1000);

    if (outcome.ended) {
        pending.then(
            (late) => debug(`${callId}: late "${late?.action}" after the wait ended; ignored`),
            () => {},
        );
        debug(`${callId}: wait ended (${outcome.ended}) after ${waited}s`);
        if (outcome.ended === "aborted") {
            return result("failure", `The host ended this tool call before the user answered. ${NOT_CONSENT}`);
        }
        return result("timeout",
            `The user did not answer within ${Math.max(1, Math.floor(timeoutMs / 60000))} minutes. The form may still be ` +
            `on screen, but a late answer will NOT reach you. ${NOT_CONSENT} Ask again later if still needed.`);
    }

    if (outcome.error) {
        const why = outcome.error?.message ?? String(outcome.error);
        debug(`${callId}: elicitation failed: ${why}`);
        return result("failure",
            `The form could not be shown (${why}). ${NOT_CONSENT} Fall back to ask_user with the context in the question.`);
    }

    const action = outcome.result?.action;
    debug(`${callId}: ${action ?? "no action"} after ${waited}s`);
    if (action === "decline") {
        return result("success", `The user DECLINED the form (pressed decline/reject). ${NOT_CONSENT}`);
    }
    if (action !== "accept") {
        return result("success",
            `The user dismissed the form without submitting (${action ?? "no action reported"}). ${NOT_CONSENT}`);
    }

    const { answers, unanswered, invalid, comment } = interpretAccept(form, outcome.result.content);
    const payload = {
        status: "submitted",
        answers,
        ...(unanswered.length ? { unanswered } : {}),
        ...(Object.keys(invalid).length ? { invalid } : {}),
        ...(comment ? { comment } : {}),
    };
    const notes = [
        unanswered.length ? `Unanswered fields were left blank by the user; do not assume values for: ${unanswered.join(", ")}.` : null,
        Object.keys(invalid).length ? "Fields under \"invalid\" came back in an unexpected shape; confirm them with the user before relying on them." : null,
        "Fields named <id>__other hold free-text answers the user typed instead of, or besides, the listed options.",
    ].filter(Boolean);
    return result("success", `The user submitted the form.\n${JSON.stringify(payload, null, 2)}\n${notes.join("\n")}`);
}

const QUESTION_SCHEMA = {
    type: "object",
    properties: {
        id: { type: "string", description: "Key for this answer in the result. Letters, digits, underscore; starts with a letter." },
        question: { type: "string", description: `Short question shown as the field label (max ${LIMITS.questionChars} chars). Put detail in context.` },
        type: { type: "string", enum: TYPES, description: "choice: pick one. multi_choice: pick several. url/email/date/datetime: validated strings." },
        options: { type: "array", items: { type: "string" }, description: "For choice/multi_choice: 2+ option labels; the chosen labels are returned verbatim." },
        default: {
            anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "array", items: { type: "string" } }],
            description: "Pre-filled answer, e.g. your recommended option. Must match the type.",
        },
        description: { type: "string", description: "Optional help text under the field." },
        required: { type: "boolean", description: "Whether the form refuses to submit without this field. Default false; blank answers are reported as unanswered." },
        allowOther: { type: "boolean", description: "For choice/multi_choice: add a free-text 'other' field." },
        min: { type: "number" }, max: { type: "number" },
        minLength: { type: "integer" }, maxLength: { type: "integer" },
        minItems: { type: "integer" }, maxItems: { type: "integer" },
    },
    required: ["id", "question", "type"],
    additionalProperties: false,
};

const session = await joinSession({
    tools: [
        {
            name: "ask_form",
            description:
                "Ask the user several related questions in ONE form, with typed fields (single or " +
                "multiple choice, yes/no, number, text, url, email, date) and your explanation shown " +
                "inside the form. Prefer this over ask_user when you have more than one question, or " +
                "when the user needs context (a plan, options, trade-offs, proposed wording) to answer: " +
                "put that context in `context`, because chat text written just before a question is " +
                "not reliably visible while the question is open. Blocks until the user submits, " +
                "declines, dismisses, or the wait times out; only a submitted form carries answers. " +
                "This is a question form only: it never replaces tool permission, sign-in, or " +
                "approval prompts, and an answer here does not grant them.",
            parameters: {
                type: "object",
                properties: {
                    context: {
                        type: "string",
                        description: `Markdown shown at the top of the form: everything the user needs to answer (max ${LIMITS.contextChars} chars).`,
                    },
                    questions: {
                        type: "array",
                        minItems: 1,
                        maxItems: LIMITS.questions,
                        items: QUESTION_SCHEMA,
                    },
                    allowComment: {
                        type: "boolean",
                        description: "Add an optional 'Anything else?' free-text field. Default true.",
                    },
                },
                required: ["context", "questions"],
            },
            skipPermission: true,
            defer: "never",
            handler: (args, invocation) => askForm(session, args, invocation),
        },
    ],
});

debug(`ask-form loaded (config=${config._configPath ?? "defaults"}, timeoutMs=${timeoutMs})`);

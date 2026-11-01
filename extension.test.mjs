import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { boot } from "./test-support/host.mjs";

const CONTEXT = "## Proposal\n\n| Group | Items |\n| --- | --- |\n| A | 12 |\n| B | 44 |\n\nPick how to proceed.";

const QUESTIONS = [
    { id: "plan", question: "How should I apply the plan?", type: "choice", options: ["All", "Some", "None"], default: "All", required: true, allowOther: true },
    { id: "groups", question: "Which groups?", type: "multi_choice", options: ["A", "B"], minItems: 1 },
    { id: "notify", question: "Notify owners?", type: "boolean", default: false },
    { id: "batch", question: "Batch size", type: "integer", min: 1, max: 50 },
    { id: "ratio", question: "Ratio", type: "number", min: 0, max: 1 },
    { id: "note", question: "Note", type: "text", maxLength: 200 },
    { id: "link", question: "Link", type: "url" },
    { id: "who", question: "Email", type: "email" },
    { id: "when", question: "Date", type: "date" },
    { id: "at", question: "Time", type: "datetime" },
];

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("a multi-field typed form round-trips with the context inside the form", async (t) => {
    const host = await boot(t);
    host.respond = () => ({
        action: "accept",
        content: {
            plan: "Some", plan__other: "only stale ones", groups: ["A", "B"], notify: "true",
            batch: 10, ratio: "0.5", note: "ok", link: "https://example.test", who: "a@example.test",
            when: "2026-11-02", at: "2026-11-02T10:00:00Z", comment: "thanks",
        },
    });
    const res = await host.call({ context: CONTEXT, questions: QUESTIONS });

    assert.equal(host.requests.length, 1);
    const { message, requestedSchema } = host.requests[0];
    assert.equal(message, CONTEXT);
    const p = requestedSchema.properties;
    assert.deepEqual(p.plan, { type: "string", title: "How should I apply the plan?", enum: ["All", "Some", "None"], default: "All" });
    assert.deepEqual(p.groups, { type: "array", title: "Which groups?", minItems: 1, items: { type: "string", enum: ["A", "B"] } });
    assert.equal(p.notify.type, "boolean");
    assert.deepEqual([p.batch.type, p.batch.minimum, p.batch.maximum], ["integer", 1, 50]);
    assert.equal(p.ratio.type, "number");
    assert.equal(p.note.maxLength, 200);
    assert.deepEqual([p.link.format, p.who.format, p.when.format, p.at.format], ["uri", "email", "date", "date-time"]);
    assert.equal(p.plan__other.type, "string");
    assert.equal(p.comment.type, "string");
    assert.deepEqual(requestedSchema.required, ["plan"]);

    assert.equal(res.resultType, "success");
    assert.match(res.textResultForLlm, /submitted the form/);
    const payload = JSON.parse(res.textResultForLlm.slice(res.textResultForLlm.indexOf("{"), res.textResultForLlm.lastIndexOf("}") + 1));
    assert.deepEqual(payload.answers, {
        plan: "Some", plan__other: "only stale ones", groups: ["A", "B"], notify: true, batch: 10,
        ratio: 0.5, note: "ok", link: "https://example.test", who: "a@example.test",
        when: "2026-11-02", at: "2026-11-02T10:00:00Z",
    });
    assert.equal(payload.comment, "thanks");
    assert.equal(payload.unanswered, undefined);
});

test("blank fields are reported as unanswered and odd shapes as invalid, never guessed", async (t) => {
    const host = await boot(t);
    host.respond = () => ({ action: "accept", content: { plan: "Maybe", notify: "yes", batch: 2.5 } });
    const res = await host.call({ context: CONTEXT, questions: QUESTIONS.slice(0, 4), allowComment: false });
    assert.equal(host.requests[0].requestedSchema.properties.comment, undefined);
    const payload = JSON.parse(res.textResultForLlm.slice(res.textResultForLlm.indexOf("{"), res.textResultForLlm.lastIndexOf("}") + 1));
    assert.deepEqual(payload.answers, {});
    assert.deepEqual(payload.unanswered, ["groups"]);
    assert.deepEqual(payload.invalid, { plan: "Maybe", notify: "yes", batch: 2.5 });
    assert.match(res.textResultForLlm, /do not assume values for: groups/);
});

for (const [action, pattern] of [["decline", /DECLINED/], ["cancel", /dismissed the form/]]) {
    test(`${action} returns no answers and is not consent`, async (t) => {
        const host = await boot(t);
        host.respond = () => ({ action, content: { plan: "All" } });
        const res = await host.call({ context: CONTEXT, questions: QUESTIONS.slice(0, 1) });
        assert.match(res.textResultForLlm, pattern);
        assert.match(res.textResultForLlm, /Do not treat this as approval/);
        assert.doesNotMatch(res.textResultForLlm, /"answers"/);
    });
}

test("an unknown action is treated as a dismissal", async (t) => {
    const host = await boot(t);
    host.respond = () => undefined;
    const res = await host.call({ context: CONTEXT, questions: QUESTIONS.slice(0, 1) });
    assert.match(res.textResultForLlm, /dismissed the form without submitting \(no action reported\)/);
});

test("a host that cannot elicit shows nothing and says so", async (t) => {
    const host = await boot(t, { elicitation: false });
    const res = await host.call({ context: CONTEXT, questions: QUESTIONS.slice(0, 1) });
    assert.equal(res.resultType, "failure");
    assert.match(res.textResultForLlm, /cannot show forms/);
    assert.equal(host.requests.length, 0);
});

test("an elicitation error is reported, not turned into an answer", async (t) => {
    const host = await boot(t);
    host.respond = () => { throw new Error("schema rejected"); };
    const res = await host.call({ context: CONTEXT, questions: QUESTIONS.slice(0, 1) });
    assert.equal(res.resultType, "failure");
    assert.match(res.textResultForLlm, /could not be shown \(schema rejected\)/);
});

test("sub-agent calls are rejected without opening a form", async (t) => {
    const host = await boot(t);
    const res = await host.call({ context: CONTEXT, questions: QUESTIONS.slice(0, 1) }, { agentId: "child" });
    assert.equal(res.resultType, "rejected");
    assert.equal(host.requests.length, 0);
});

test("invalid requests are rejected with actionable errors and nothing shown", async (t) => {
    const host = await boot(t);
    const cases = [
        [{ questions: QUESTIONS.slice(0, 1) }, /"context" is required/],
        [{ context: "  ", questions: QUESTIONS.slice(0, 1) }, /"context" is required/],
        [{ context: "x".repeat(20001), questions: QUESTIONS.slice(0, 1) }, /exceeds 20000/],
        [{ context: CONTEXT, questions: [] }, /non-empty array/],
        [{ context: CONTEXT, questions: Array.from({ length: 11 }, (_, i) => ({ id: `q${i}`, question: "Q", type: "boolean" })) }, /At most 10 questions/],
        [{ context: CONTEXT, questions: [{ id: "1bad", question: "Q", type: "boolean" }] }, /"id" must match/],
        [{ context: CONTEXT, questions: [{ id: "comment", question: "Q", type: "boolean" }] }, /"id" must match/],
        [{ context: CONTEXT, questions: [{ id: "a", question: "Q", type: "boolean" }, { id: "a", question: "Q", type: "boolean" }] }, /duplicate id "a"/],
        [{ context: CONTEXT, questions: [{ id: "a", question: "Q", type: "slider" }] }, /"type" must be one of/],
        [{ context: CONTEXT, questions: [{ id: "a", question: "Q", type: "choice", options: ["only"] }] }, /at least 2/],
        [{ context: CONTEXT, questions: [{ id: "a", question: "Q", type: "choice", options: ["x", "x"] }] }, /duplicate option/],
        [{ context: CONTEXT, questions: [{ id: "a", question: "Q", type: "choice", options: ["x", "y"], default: "z" }] }, /one of the options/],
        [{ context: CONTEXT, questions: [{ id: "a", question: "Q", type: "integer", min: 5, max: 1 }] }, /"min" is greater than "max"/],
        [{ context: CONTEXT, questions: [{ id: "a", question: "Q", type: "integer", default: 1.5 }] }, /must be an integer/],
        [{ context: CONTEXT, questions: [{ id: "a", question: "Q", type: "boolean", options: ["x", "y"] }] }, /only applies to choice/],
        [{ context: CONTEXT, questions: [{ id: "a", question: "Q".repeat(301), type: "boolean" }] }, /move detail into "context"/],
        [{ context: CONTEXT, questions: [{ id: "a", question: "Q", type: "text", allowOther: true }] }, /"allowOther" only applies/],
        ["nope", /must be an object/],
    ];
    for (const [args, pattern] of cases) {
        const res = await host.call(args);
        assert.equal(res.resultType, "failure", `expected failure for ${pattern}`);
        assert.match(res.textResultForLlm, /nothing was shown to the user/);
        assert.match(res.textResultForLlm, pattern);
    }
    assert.equal(host.requests.length, 0);
});

test("a second form while one is open is refused", async (t) => {
    const host = await boot(t);
    let answer;
    host.respond = () => new Promise((resolve) => { answer = resolve; });
    const first = host.call({ context: CONTEXT, questions: QUESTIONS.slice(0, 1) });
    await flush();
    const second = await host.call({ context: CONTEXT, questions: QUESTIONS.slice(0, 1) });
    assert.match(second.textResultForLlm, /already waiting/);
    answer({ action: "accept", content: { plan: "All" } });
    assert.match((await first).textResultForLlm, /"plan": "All"/);
    host.respond = () => ({ action: "cancel" });
    const third = await host.call({ context: CONTEXT, questions: QUESTIONS.slice(0, 1) });
    assert.doesNotMatch(third.textResultForLlm, /already waiting/);
});

test("host abort ends the wait truthfully and a late answer is ignored", async (t) => {
    const host = await boot(t);
    let answer;
    host.respond = () => new Promise((resolve) => { answer = resolve; });
    const controller = new AbortController();
    const call = host.call({ context: CONTEXT, questions: QUESTIONS.slice(0, 1) }, { signal: controller.signal });
    await flush();
    controller.abort();
    const res = await call;
    assert.equal(res.resultType, "failure");
    assert.match(res.textResultForLlm, /host ended this tool call before the user answered/);
    answer({ action: "accept", content: { plan: "All" } });
    await flush();
    const log = readFileSync(join(host.root, "debug.log"), "utf8");
    assert.match(log, /late "accept" after the wait ended; ignored/);
    assert.doesNotMatch(log, /"All"/, "answer content must not be logged");
});

test("the wait times out before the host's 1800 s tool limit, without waiting", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    // Configured above the host limit: the extension must clamp it below 1800 s.
    const host = await boot(t, { config: { timeoutMs: 3_600_000 } });
    host.respond = () => new Promise(() => {});
    let settled = null;
    const call = host.call({ context: CONTEXT, questions: QUESTIONS.slice(0, 1) }).then((r) => { settled = r; });
    await flush();
    t.mock.timers.tick(1_790_000 - 1);
    await flush();
    assert.equal(settled, null, "must still be waiting just before the clamp");
    t.mock.timers.tick(1);
    await call;
    assert.equal(settled.resultType, "timeout");
    assert.match(settled.textResultForLlm, /did not answer within 29 minutes/);
    assert.match(settled.textResultForLlm, /late answer will NOT reach you/);
});

test("the configured timeout is honoured when shorter", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const host = await boot(t, { config: { timeoutMs: 120_000 } });
    host.respond = () => new Promise(() => {});
    let settled = null;
    const call = host.call({ context: CONTEXT, questions: QUESTIONS.slice(0, 1) }).then((r) => { settled = r; });
    await flush();
    t.mock.timers.tick(119_999);
    await flush();
    assert.equal(settled, null);
    t.mock.timers.tick(1);
    await call;
    assert.match(settled.textResultForLlm, /within 2 minutes/);
});

test("the tool is always loaded and never claims to replace permission prompts", async (t) => {
    const host = await boot(t);
    const tool = host.options.tools.find((x) => x.name === "ask_form");
    assert.equal(tool.defer, "never");
    assert.equal(tool.overridesBuiltInTool, undefined);
    assert.deepEqual(tool.parameters.required, ["context", "questions"]);
    assert.match(tool.description, /never replaces tool permission, sign-in, or approval prompts/);
    assert.equal(host.options.tools.length, 1);
    assert.equal(host.options.askUserVariant, undefined);
    assert.equal(host.options.onElicitationRequest, undefined);
});

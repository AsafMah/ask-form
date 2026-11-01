// A stub host: resolves the SDK import to sdk.mjs, captures joinSession's options, and records
// every elicitation the extension requests. Each test decides how (and whether) it is answered.
import { registerHooks } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "@github/copilot-sdk/extension") {
            return { url: new URL("./sdk.mjs", import.meta.url).href, shortCircuit: true };
        }
        return nextResolve(specifier, context);
    },
});

export async function boot(t, { config = {}, elicitation = true } = {}) {
    const root = mkdtempSync(join(tmpdir(), "ask-form-host-"));
    const oldConfig = process.env.COPILOT_ASK_FORM_CONFIG;
    const configPath = join(root, "ask-form.json");
    writeFileSync(configPath, JSON.stringify({ debugLog: join(root, "debug.log"), ...config }));
    process.env.COPILOT_ASK_FORM_CONFIG = configPath;

    const host = {
        root,
        requests: [],
        // Default answer; tests replace it with a function or a never-settling promise.
        respond: () => ({ action: "cancel" }),
        session: {
            sessionId: randomUUID(),
            capabilities: { ui: { elicitation } },
            ui: {
                async elicitation(params) {
                    host.requests.push(params);
                    return host.respond(params);
                },
            },
        },
        call(args, invocation = {}) {
            const tool = host.options.tools.find((x) => x.name === "ask_form");
            return tool.handler(args, { toolCallId: randomUUID(), ...invocation });
        },
    };
    globalThis[Symbol.for("ask-form-test-host")] = host;
    t.after(() => {
        if (oldConfig === undefined) delete process.env.COPILOT_ASK_FORM_CONFIG;
        else process.env.COPILOT_ASK_FORM_CONFIG = oldConfig;
        delete globalThis[Symbol.for("ask-form-test-host")];
        rmSync(root, { recursive: true, force: true });
    });
    await import(`../extension.mjs?test=${randomUUID()}`);
    return host;
}

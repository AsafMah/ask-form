export async function joinSession(options) {
    const host = globalThis[Symbol.for("ask-form-test-host")];
    if (!host) throw new Error("No isolated ask-form test host");
    host.options = options;
    return host.session;
}

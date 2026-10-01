/** Collects every resolved secret value so ALL output can be scrubbed, plus generic token-param scrubbing. */
export class Redactor {
    secrets = new Set();
    add(value) {
        if (value && value.length >= 4)
            this.secrets.add(value);
    }
    redact(text) {
        let out = String(text ?? "");
        // longest first so a secret containing another secret is fully removed
        for (const s of [...this.secrets].sort((a, b) => b.length - a.length))
            out = out.split(s).join("<REDACTED>");
        out = out.replace(/([?&](?:token|shell_secret|api_key|apikey|key|secret|code|state)=)[^&\s"'<>]+/gi, "$1<REDACTED>");
        out = out.replace(/(x-api-key\s*[:=]\s*)[^\s"',()]+/gi, "$1<REDACTED>");
        return out;
    }
}
//# sourceMappingURL=redact.js.map
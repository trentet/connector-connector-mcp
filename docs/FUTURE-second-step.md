# Future: second-step (2-Step Verification) options for unattended sign-in

Status: specification note only. Nothing here is built. Added 2026-10-16 on the operator's request (priority: low).

## Why
cc signs in to Google accounts without a person (weekly OAuth renewal, `cc reauth`). If an account is forced to use a second step, the login stalls. The robot account was decided to run WITHOUT 2-Step Verification if Google allows it (handoff decision D34); this note records what to do if Google forces it.

## Options, in the order to try
1. Authenticator code (TOTP) from the vault: the secret key is stored in the vault, cc asks the vault for a current code at sign-in. Needs a one-time setup and a vault that can generate codes (Vaultwarden/Bitwarden can). Decision D34 already names this the stronger fallback.
2. Backup codes: single use and finite. A fallback only.
3. Passkey through a software authenticator: Chrome DevTools offers a virtual WebAuthn authenticator that browser automation can drive. Untested with Google. Needs a trial.
4. Text or voice code: needs a phone number the system can read. See the emulated-phone item.
5. Not usable unattended: Google prompt on a phone, a physical security key, an email code (Google does not offer email as a second step, as far as found).

## Emulated phone (lowest priority, keep in the specification)
A virtual device that can: run an authenticator app; receive text messages; receive phone calls, understand the audio prompt (speech to text), and answer it (keypad tones or text to speech). Candidates to research when needed: SMS/voice gateway or virtual-number services with an API, Android emulator images, speech to text and text to speech engines. Risks to check first: provider terms, whether Google accepts virtual numbers, cost, and holding the numbers' credentials in the vault.
Research is assigned to the identity and access management controller thread (spec item F).

## Related
- Identity and access management controller thread: central account list, account creation, mail server, phone web UI.
- cc vault access: `docs/SPEC.md`.

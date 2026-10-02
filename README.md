# connector-connector-mcp ("cc")
Connector Connector: add, remove, update, list and verify MCP connectors on claude.ai, ChatGPT and Grok. Rules for anyone working here: `CLAUDE.md`. Design: `docs/SPEC.md`.

## How the browser side works, in one paragraph
Every cc run drives its own Chrome process on its own copy of a signed-in "master" profile, so any number of callers (CLI, MCP server, several Claude threads) can run at the same time without touching each other's tabs.
The master profile is signed in ONCE by copying the sign-ins out of a Chrome you already use; after that it keeps itself fresh. Steps 3 to 6 below are the only setup this model adds.

## Full walkthrough, step 1 to done
Every step is tagged **[SCRIPTED]** (run the command, nothing to decide) or **[MANUAL]** (a person does it in an app, listed click by click). Run all commands from the cc repo folder in PowerShell on the HELM host.

1. **[SCRIPTED]** Install dependencies and build.
   `npm ci` then `npm run build`. Produces `dist\`. Nothing to copy.
2. **[SCRIPTED]** Create the tunnel, DNS record and secrets file for each environment (skip if already done; it never overwrites an existing secrets file).
   `.\scripts\setup-host.ps1 -Environment production` then `.\scripts\setup-host.ps1 -Environment test`.
   Produces `%LOCALAPPDATA%\HELM\connector-connector-mcp\<env>\secrets\connector.env` (contains `CC_MCP_BEARER_TOKEN`; never printed). The token goes to whoever registers the cc connector itself: cc reads it by reference from that file.
3. **[MANUAL]** Make sure ONE Chrome on this machine is signed in to all three sites. Use the Chrome that is already running with remote debugging on port 9222 (the shared HELM browser). If none is running, start one: Windows key, type `cmd`, Enter, then
   `"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir=%TEMP%\cc-signin` and press Enter. In that Chrome window:
   1. Address bar: type `claude.ai`, Enter. If you see a login page, click **Continue with Google**, click the account `trenterrolthomas@gmail.com`, click **Continue**. Wait until your chats list is visible.
   2. Address bar: type `chatgpt.com`, Enter. If you see **Log in**, click it, click **Continue with Google**, click the same Google account. ChatGPT then texts a code to your phone: type it into the **Code** box and click **Continue**. Wait until the chat page is visible.
   3. Address bar: type `grok.com`, Enter. If you see **Sign in**, click it, click **Login with email**, type the email, click **Next**, type the password, click **Log in**. (The Grok email and password are in the vault under the label `Grok`.) Wait until the chat page is visible.
   Produces: nothing to copy. The sign-ins now live in that Chrome, which step 4 reads.
4. **[SCRIPTED]** Copy those sign-ins into cc's cold master profile.
   `node bin\cc.mjs browser seed --from-port 9222`
   Expected output, one line per platform: `claude     N cookies copied, signed in: yes` (and the same for `chatgpt` and `grok`). Produces the folder `%LOCALAPPDATA%\HELM\connector-connector-mcp\browser-master` (override with `CC_BROWSER_MASTER`). No cookie value is printed or written anywhere else. Leave the source Chrome running or close it; cc does not use it again.
5. **[SCRIPTED]** Prove the master works in a throwaway browser.
   `node bin\cc.mjs browser check`
   Expected: `claude signed in: yes`, `chatgpt signed in: yes`, `grok signed in: yes`, exit code 0. The browser it launched is closed and deleted when the command ends.
6. **[MANUAL]** Only if step 4 or 5 printed `NO` for a platform: repeat the matching sub-step of step 3 in the source Chrome (that platform's login is missing or expired there), then run step 4 again. Nothing else changes.
7. **[SCRIPTED]** Deploy and start (stop the running instance first; the deploy refuses a running one).
   `node scripts\deploy.mjs production main` then `node scripts\install-tasks.ps1 -Environment production -Start`; repeat with `test`.
   Produces `deploy\<env>\DEPLOYED.json` (commit that is running) and the four AtLogOn scheduled tasks.
8. **[SCRIPTED]** Prove concurrency on the real platforms: three runs at the same moment, three separate browsers.
   `Start-Process node -ArgumentList 'bin\cc.mjs','verify','helm-drive','--platform','claude' -RedirectStandardOutput $env:TEMP\cc-a.log; Start-Process node -ArgumentList 'bin\cc.mjs','verify','helm-shell','--platform','chatgpt' -RedirectStandardOutput $env:TEMP\cc-b.log; Start-Process node -ArgumentList 'bin\cc.mjs','verify','vault-mcp','--platform','grok' -RedirectStandardOutput $env:TEMP\cc-c.log`
   Wait about a minute, then `Get-Content $env:TEMP\cc-a.log,$env:TEMP\cc-b.log,$env:TEMP\cc-c.log`. Expected: three `ok verify ...` lines and no `Target page, context or browser has been closed`.
9. **[SCRIPTED]** Routine use (nothing to set up): `node bin\cc.mjs add <id> --platform chatgpt grok`, `verify`, `remove`, `list`, or the same through the `cc_run` MCP tool. Concurrent callers are fine; at most `CC_MAX_CONCURRENCY` (default 4) browsers run at once and extra callers wait, then fail with a clear "all lanes are busy" error after `CC_LANE_WAIT_MS` (default 120 s).

### Keeping the master fresh
Each healthy run writes its refreshed cookies back to the master automatically (only if every platform it touched still showed a signed-in cookie, and only if no newer run wrote first). If a platform signs out anyway (password change, long idle), `cc browser check` says `NO`: do step 3 for that platform and step 4 again.

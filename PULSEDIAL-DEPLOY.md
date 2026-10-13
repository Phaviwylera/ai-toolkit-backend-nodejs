# PulseDial | Live Twilio deployment

The dedicated `pulsedial-deploy` branch contains the real-calling PulseDial application. It is isolated from `main`.

## Current state
- Full live Twilio REST Voice/SMS and recipient-initiated WhatsApp consent flow are included.
- All 12 local automated tests passed as of October 13, 2026.
- **Not deployed**. No real phone calls have been placed.
- The credentials supplied in chat were **never written to this repository**. Because that Auth Token has been disclosed in a conversation, rotate it before using it for production.

## Render setup

1. Open https://dashboard.render.com/web/new and connect `Phaviwylera/ai-toolkit-backend-nodejs`, **branch `pulsedial-deploy`**.
2. Use Node.js, Singapore region. **Always-on starter (paid) instance + a persistent disk** mounted at `/var/data`. Render Free can sleep and lose local history; never use it for live auto-redial.
3. Build: `node bootstrap.cjs` / Start: `node src/server.js` / health path: `/health`.
4. Set server-side environment variables in Render (not in GitHub and not in chat):

| Name | Example or required format |
| --- | --- |
| `NODE_VERSION` | `22` |
| `MODE` | `demo` until fully configured; then `twilio` |
| `HOST` | `0.0.0.0` |
| `REQUIRE_LOGIN` | `1` |
| `DATA_FILE` | `/var/data/pulsedial.json` |
| `ADMIN_PASSWORD` | A newly generated unique secret, 16+ characters |
| `TWILIO_ACCOUNT_SID` | Your Twilio Account SID, entered privately |
| `TWILIO_AUTH_TOKEN` | Your **rotated** Twilio Auth Token, entered privately |
| `TWILIO_VOICE_FROM` | Your authorized voice-enabled international phone number in E.164, e.g. `+1...` |
| `TWILIO_SMS_FROM` | Your two-way SMS-capable Twilio number (if SMS opt-in used) |
| `TWILIO_WHATSAPP_FROM` | `whatsapp:+...` for a **registered WhatsApp Business sender** (required for India's WhatsApp opt-in route) |
| `PUBLIC_BASE_URL` | Exact Render HTTPS origin, e.g. `https://your-service.onrender.com` |

The included `render.yaml` is a **paid starter** Blueprint template. Do not apply it unless you agree to Render's displayed pricing. It defaults to demo. The source uses a compressed archival bundle restored by `bootstrap.cjs` (no user credentials inside).

5. In Twilio enable Voice geographical dialing permissions for the recipient's destination and make sure your Twilio account is upgraded, funded, and permitted to call the destination.
6. If using WhatsApp recipient opt-in for India, register a production WhatsApp sender in Twilio/Meta, and set its inbound webhook to `https://YOUR_HTTPS_HOST/webhooks/whatsapp`, POST.
7. If using non-Indian two-way SMS confirmation, set the Twilio SMS number's incoming message webhook to `https://YOUR_HTTPS_HOST/webhooks/sms`, POST.
8. Update `MODE` to `twilio` **only after** HTTPS, persistent storage, credentials, sender, geographic permission, signed webhooks and the recipient's affirmative consent channel are working. Restart the service; check `/health` returns `{"ok":true,"mode":"twilio"}`.

## Guardrails (enforced by server)

- Require affirmative opt-in from the same recipient phone number; India uses WhatsApp, otherwise replies to an inbound SMS challenge where supported.
- Consent expires after 24 hours; STOP/opt-out cancels subsequent attempts.
- At most five calls to each number within any rolling 24 hours and per campaign, at least ten minutes apart, 09:00–20:00 in recipient's timezone.
- Stop retrying on `in-progress` (answered), including voicemail detection limitation; stop manual calls on request.
- In ambiguous callback/restart states, stop/pause rather than dialing blindly.
- **Audio:** the call plays an automated spoken message. Browser microphone live conversations are *not* implemented in this edition.
- Caller charges and telecom legal restrictions apply. India does not allow voice OTP/2FA through Twilio, and short calls at high volume can be blocked.

## Security and privacy

Never put Twilio tokens in code, a Git commit, screenshots, chats, or a public file. Use Render environment variables and rotate compromised tokens in the Twilio Console. The admin login is required. Only one live server instance should access the current file-based persistence. This application is not a multi-tenant enterprise system.

## Repo

GitHub URL: https://github.com/Phaviwylera/ai-toolkit-backend-nodejs/tree/pulsedial-deploy

# PulseDial — Render deployment

This branch is an isolated deployment build of PulseDial. It does not modify the repository's `main` branch.

## Deploy as a Render Web Service

1. In [Render](https://dashboard.render.com/web/new), create **Web Service** from **Phaviwylera/ai-toolkit-backend-nodejs**.
2. Set **Branch** = `pulsedial-deploy`; **Runtime** = Node; **Region** = Singapore; **Instance** = Free.
3. **Build Command**: `node bootstrap.cjs`
4. **Start Command**: `node src/server.js`
5. **Health Check Path**: `/health`
6. Add these environment variables in Render (do **not** put them in Git):

| Key | Value |
| --- | --- |
| NODE_VERSION | `22` |
| MODE | `demo` |
| HOST | `0.0.0.0` |
| REQUIRE_LOGIN | `1` |
| ADMIN_PASSWORD | A unique randomly generated password, at least 16 characters |

7. Click **Deploy Web Service**. When ready, open the HTTPS URL shown on the service page and log in using your private ADMIN_PASSWORD.

## Notes

- Demo mode **never sends calls or SMS**. It simulates consent and redial outcomes, including the 5-attempt maximum, 10-minute minimum spacing, recipient quiet hours and auto-stop after an answered call.
- The Git branch contains `pulsedial-source.br.b64` (compressed source code) and `bootstrap.cjs`. The build command restores the app's JS/HTML/CSS to the service filesystem.
- Render Free web service storage is ephemeral and free instances may spin down. Do not rely on it for persistent campaign or consent records. Before offering live calling, provision durable storage and confirm opt-in and safe-retry controls.
- Do not switch to `MODE=twilio` until telephony credentials, provider webhook configuration, persistent storage and recipient consent have been tested in a secure live configuration.

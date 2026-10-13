# PulseDial: activate REAL outbound calls (consent first)

This deployment branch contains the upgraded live-Twilio source in `pulsedial-source.br.b64`. `node bootstrap.cjs` restores the source files during Render's build step. The original main branch is untouched.

## Deployment: Render web service

Real calling requires an always-on **paid** Render Web Service and a **persistent disk** so consent, opt-outs, and daily call attempt counts survive restarts. Do not use Render Free for real calls; Free instances sleep and lose local data on restart/redeploy.

- Region: **Singapore**. Plan: **Starter or greater** (billable).
- Disk: name `pulsedial-data`, mount path `/var/data`, size 1 GB.
- Repository: `Phaviwylera/ai-toolkit-backend-nodejs`, branch: `pulsedial-deploy`.
- Build command: `node bootstrap.cjs`.
- Start command: `node src/server.js`.
- Health check: `/health`.
- Runtime: Node 22 or newer.

## Secret environment variables — configure privately in Render

```dotenv
NODE_VERSION=22
MODE=twilio
HOST=0.0.0.0
REQUIRE_LOGIN=1
DATA_FILE=/var/data/pulsedial.json
ADMIN_PASSWORD=<unique secret, 16+ characters>
TWILIO_ACCOUNT_SID=<your Twilio Account SID>
TWILIO_AUTH_TOKEN=<your Twilio Auth Token>
TWILIO_VOICE_FROM=<your Twilio-approved international voice number in +E.164 format>
TWILIO_WHATSAPP_FROM=whatsapp:<registered WhatsApp sender in +E.164 format>
# Optional for recipients outside India who can reply to SMS
TWILIO_SMS_FROM=<two-way SMS-capable number in +E.164 format>
PUBLIC_BASE_URL=https://<actual Render hostname>.onrender.com
```

**Do not commit real secrets to GitHub or paste them into this chat.** Configure these in Render. Call charges and Render hosting charges apply; review them and explicitly opt into a paid plan before creating a paid service. The app's live voice plays a short automated message; it is not a live browser-microphone call.

## Indian (+91) recipients

Twilio's India voice guidelines require calls into India from an **international, non-Indian number**. Twilio SMS to India is one-way (recipient replies cannot reach your Twilio number); consequently, this app requires **recipient-initiated WhatsApp opt-in for +91 numbers**.

1. Set up a **production approved Twilio WhatsApp sender**. Twilio's WhatsApp sandbox is for testing only.
2. Configure its **incoming message** webhook to `POST https://<actual Render hostname>.onrender.com/webhooks/whatsapp`.
3. Open PulseDial, choose the recipient's +91 phone number, and press **Request consent**.
4. Privately share the generated WhatsApp opt-in link with the intended recipient. The recipient reviews the disclosure and must send it from **their own WhatsApp number**. Nothing is dialed until Twilio signs and delivers that inbound opt-in.
5. Start the live campaign after consent is verified. Calling only happens 9am–8pm recipient local time, at most five tries per rolling 24 hours and at least 10 minutes apart; answered calls, STOP messages, and manual Stop end retries.

## For non-Indian numbers

Use a two-way Twilio SMS number and configure incoming messages to `POST https://<actual Render hostname>.onrender.com/webhooks/sms`. The recipient independently replies with the one-time YES code sent by SMS.

## Verification

The latest source bundle passed 12 automated tests, including forged-webhook rejection, Indian WhatsApp consent, recipient opt-out, missed-call retries, and answer-triggered termination. Actual carrier calls have **not** been placed because no telephony credentials are connected.

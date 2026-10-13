# Relay — Free WhatsApp + Internet Voice Call Website

This is a separate branch from the existing PulseDial / Twilio carrier calling system.

- `free-relay-archive.br.b64`: compressed bundle of `index.html`, `styles.css`, `app.js`, `icon.svg`.
- `build-relay.cjs`: extracts the complete source and static assets into `free-relay/`.
- `render.yaml`: an optional free static site specification.
- Run `node build-relay.cjs` then `python3 -m http.server -d free-relay 8080`.

**Capabilities:** WhatsApp click-to-chat with prefilled message (user presses Send in WhatsApp); Jitsi internet calling room link, WhatsApp invite, WhatsApp app calling instructions; mobile `tel:` dialer. Free from Relay; WhatsApp and Jitsi require data/internet and may require app sign-in.

**Not a free PSTN calling gateway:** cannot make a free call from `+1 737 250 8034` to a regular mobile number. Those carrier calls require per-minute charges and telecom service, for which the separate PulseDial Twilio version is preserved on branch `pulsedial-deploy`.

**No API keys or destination numbers are committed.** Recipient input and basic activity stay in browser local storage.

Deploy in Render Static Sites from this branch with `node build-relay.cjs` and `free-relay` publish path.

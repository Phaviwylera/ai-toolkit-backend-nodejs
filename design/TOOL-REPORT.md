# StreamSave design engineering

The app has no package.json: it is FastAPI + yt-dlp + FFmpeg, plain HTML/CSS/JavaScript, built in a Node 22/Python Docker image. No React, shadcn or Tailwind runtime was added.

## Tool execution

- Built Microck/font-mcp from its GitHub source and connected to its stdio MCP server with the official MCP client SDK.
- Called analyze_project_and_recommend against this project. Its package.json heuristic returned its generic default and no technical stack because the app has no Node manifest. The Python stack was verified directly from requirements.txt and Dockerfile.
- Called consult_font_expert. Its live research did not find useful matches. Font choice is an authored design decision, not an asserted tool recommendation.
- Called setup_font_config for Barlow Condensed. Used its self-hosted @font-face approach with actual verified WOFF2 files and actual weight mappings rather than placeholder paths.
- Installed DesignLang 13.3.2 and verified its MCP tools. Called extract_design on the existing deployed StreamSave site as a baseline. Extraction failed due to no browser. Its install-browser command failed because the downloaded Chromium ZIP was empty/invalid in this environment. No measured extraction, screenshot or pixel-perfect comparison is claimed.
- No inspiration URLs were supplied. This is an original Film Archive direction. design/tokens.json contains custom authored DTCG tokens, not fabricated extracted measurements.

## Production system

Barlow Condensed display, Instrument Sans variable body, IBM Plex Mono metadata, with Noto Sans Tamil for Tamil video titles. WOFF2 assets are self-hosted under fonts/ and carry their OFL licenses. CSS primitives and semantic tokens live in assets/design-system.css. Controls use ss-button, input-wrap, ss-select, video-sheet and job-row wrappers. tailwind.config.cjs supplies an optional equivalent mapping without adding Tailwind as a dependency.

Film Archive uses warm paper, charcoal ink, vermilion actions, olive success states, fine rules, 3px controls, 6px paper surfaces, subtle multi-layer shadows, and a deliberately limited 4/8/12/16/24/32/48/64/96px spacing scale. Micro-labels use monospace; body controls and actual content remain readable. No glass panels or gradient backgrounds. Reduced-motion support, keyboard focus, semantic landmarks and live status messages are included.

## Optional local design tools

Run node tools/setup-design-tools.mjs from a local checkout, then load .mcp.json in an MCP-compatible editor. The font server path is relative to this project and expects .tools/font-mcp/dist/index.js. DesignLang launches through npx at the pinned version. These authoring tools are separate from the deployed app: visitors only open the website.

Custom inspiration extraction can be rerun with extract_design when a browser and reference URLs are available. This session does not dynamically register these tools into ChatGPT; it called their local stdio servers directly.

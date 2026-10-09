# Deploying the public demo

The public demo is **read-only**: visitors see the live regime, limits and agent activity, but the pause and crash-simulation controls are disabled (the web page hides them and the server refuses them). It runs on Solana devnet.

One Docker container runs everything:

| Part | Where | Reachable from the internet |
|---|---|---|
| Web app (Next.js, `web/`) | port 7860 | yes |
| Dashboard API (`scripts/40-dashboard.ts`, `PUBLIC_DEMO=1`) | `127.0.0.1:3000` inside the container | no, only through the web app's `/api/*` rewrite |
| Keeper (`scripts/21-keeper.ts`) | background process | no |
| Demo agent (`scripts/30-agent.ts`) | background process | no |

## What the server needs (secrets)

The devnet setup (`npm run init`, `guardsetup`, `agentsetup`) is done once on your own machine. The server then needs:

| Secret | What it is |
|---|---|
| `KEY_AGENT` | contents of `.keys/agent.json` (one line, a list of numbers) |
| `KEY_ORACLE` | contents of `.keys/oracle.json` |
| `AGENT_CONFIG_JSON` | contents of `.agent-config.json` |
| `OWNER_PUBKEY` | the owner's **public** address, from `npm run pubkeys` |
| `GUARD_PROGRAM_ID`, `MINT_ADDRESS`, `RECEIVER_ATA` | the same values as in your local `.env` |
| `RPC_URL` | optional, defaults to the public devnet RPC |

The owner's secret key (`.keys/owner.json`) is **not** needed and must never be uploaded. Only the three wallets above live on the server, and they are devnet wallets.

Never commit `.env`, `.keys/` or `.agent-config.json` (they are in `.gitignore` and `.dockerignore`).

## Hugging Face Docker Space

1. On huggingface.co create a new **Space**: SDK **Docker**, template **Blank**.
2. In the Space, open **Settings → Variables and secrets** and add every item from the table above as a **Secret**.
3. Get the code into the Space (PowerShell, from the project folder, on the branch you want to deploy):

   ```powershell
   git clone https://huggingface.co/spaces/<your-user>/<space-name> ..\space
   git archive --format=zip -o ..\code.zip HEAD
   Expand-Archive ..\code.zip -DestinationPath ..\space -Force
   Copy-Item deploy\space-README.md ..\space\README.md -Force
   cd ..\space
   git add .
   git commit -m "Deploy RegimeGuard demo"
   git push
   ```

   `git archive` only exports tracked files, so `node_modules`, `.env` and `.keys` can never end up in the Space. When git asks for a password, use a Hugging Face access token with write permission.
4. Open the **Logs** tab. The build takes a few minutes. When it is running, the demo is at `https://<your-user>-<space-name>.hf.space`.

If the logs say `Missing secret: ...`, add that secret and restart the Space.

## Things to know

- A free Space goes to sleep when nobody uses it. While it sleeps the keeper is stopped, and after 10 minutes without an oracle update the guard treats the market as CRISIS (limit 0). That is the safety behaviour working as designed. Open the Space before a demo and give it a minute.
- Files inside the container (such as `.agent-log.jsonl`) are lost on restart, so the activity list starts empty after a restart and fills up as the agent runs.
- To try the container locally: `docker build -t regimeguard .` then run it with the secrets as `-e` flags and `-p 7860:7860`.

## Operator controls

Pause and the crash simulation stay available on your own machine (`npm run dashboard` without `PUBLIC_DEMO`). For a real product, pause should be signed by the owner's own wallet in the browser, not by a server key.

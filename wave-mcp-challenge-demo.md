# Wave Compute MCP — Base44 Challenge Demo
## "Zero to Deployed AI App in 90 Seconds — From Inside Cursor"

---

## PART 1: First-Time Cursor Setup Guide (Step by Step)

### What You Need Before Starting
1. **Cursor IDE** installed — download from cursor.com (free)
2. **Wave OS account** — sign up at oswave.io (free, 100 credits included)
3. **Your Wave API Token** — get it from oswave.io → Settings → Developer → API Tokens → Generate New Token

### Step 1: Install Cursor
1. Go to cursor.com
2. Click "Download" — it auto-detects your OS (Windows/Mac/Linux)
3. Run the installer (.exe on Windows, .dmg on Mac)
4. Open Cursor — it looks like VS Code (it's a fork)
5. Skip the sign-in for now, click "Continue" through the welcome screen

### Step 2: Configure the Wave Compute MCP Server
This is the magic step — it connects Cursor to Wave OS's backend (Base44 entities + Theta GPU compute).

1. In Cursor, press `Ctrl+Shift+P` (Windows) or `Cmd+Shift+P` (Mac) to open the Command Palette
2. Type "Preferences: Open User Settings (JSON)" and hit Enter
3. In the search bar at the top, type "mcp" — you'll see "Cursor Settings > MCP"
4. Click on "MCP" in the sidebar
5. Click "Add New MCP Server" (green button at top right)
6. Fill in these EXACT values:
   - **Name:** `wave-compute`
   - **Type:** `http`
   - **URL:** `https://oswave.io/api/functions/mcpRouter`
   - **Headers:** Click "Add Header"
     - Key: `Authorization`
     - Value: `Bearer YOUR_WAVE_API_TOKEN` (paste your actual token from oswave.io)

   ⚠️ Replace `YOUR_WAVE_API_TOKEN` with the actual token from oswave.io → Settings → Developer

7. Click "Save"
8. You should see a **green dot** appear next to "wave-compute" — this means the MCP server is connected
9. If you see a red dot: check your token is correct and the URL is exactly `https://oswave.io/api/functions/mcpRouter`

### Step 3: Verify the Connection
1. Open a new file in Cursor (`Ctrl+N` / `Cmd+N`)
2. Save it as `test-wave.js` (`Ctrl+S` / `Cmd+S`)
3. Open the AI chat panel — press `Ctrl+L` (Windows) or `Cmd+L` (Mac)
4. At the top of the chat panel, you'll see a model dropdown — make sure it's set to any model
5. Type this and hit Enter:
   ```
   List all the Wave OS entities available
   ```
6. Cursor will call the MCP `wave_entity_list` tool — you should see 28 tools available and 50+ entities returned (Suite, Note, ComputeSession, CodeProject, etc.)

✅ If you see entities — you're connected. Move to the demo.
❌ If you see an error — verify:
  - The URL is exactly: `https://oswave.io/api/functions/mcpRouter`
  - Your Wave API Token is valid (regenerate at oswave.io → Settings → Developer)
  - The type is `http` (not `sse`)
  - The Authorization header is `Bearer YOUR_TOKEN` (with the word "Bearer" and a space before the token)

### Step 4: Alternative Setup — Direct mcp.json Edit
If the UI above doesn't work, you can edit the config file directly:

1. Press `Ctrl+Shift+P` / `Cmd+Shift+P`
2. Search "Preferences: Open User Settings (JSON)"
3. Add this block to your settings.json (merge with existing settings, don't replace everything):

```json
{
  "mcpServers": {
    "wave-compute": {
      "url": "https://oswave.io/api/functions/mcpRouter",
      "type": "http",
      "headers": {
        "Authorization": "Bearer YOUR_WAVE_API_TOKEN"
      }
    }
  }
}
```

4. Save the file
5. Restart Cursor (`Ctrl+Shift+P` → "Developer: Reload Window")
6. Check for the green dot in the MCP settings — you should see 28 tools loaded

### Optional: Also Connect the Base44 MCP
For the full experience, you can run both MCPs side by side:

```json
{
  "mcpServers": {
    "base44": {
      "url": "https://app.base44.com/mcp",
      "type": "http"
    },
    "wave-compute": {
      "url": "https://oswave.io/api/functions/mcpRouter",
      "type": "http",
      "headers": {
        "Authorization": "Bearer YOUR_WAVE_API_TOKEN"
      }
    }
  }
}
```

- **base44** = the official Base44 MCP (your app's entities + pages)
- **wave-compute** = Wave OS MCP (Theta GPU compute + Wave OS entities + AI chat + 28 tools)

They complement each other with zero overlap.

---

## PART 2: The 28 MCP Tools

When connected, Cursor gets access to these 28 tools through the Wave Compute MCP:

| Category | Tools | Description |
|----------|-------|-------------|
| **Wave OS Core** | `wave`, `wave_check_messages`, `wave_send_message`, `wave_save_memory`, `wave_recall_memory` | Chat, messaging, memory |
| **Wave OS Intelligence** | `wave_morning_briefing`, `wave_triage`, `wave_meeting_prep`, `wave_follow_up_scan`, `wave_delegate_subagent` | Chief of Staff, automation |
| **Wave OS Entities** | `wave_entity_list`, `wave_entity_create`, `wave_entity_update`, `wave_entity_delete` | CRUD on Wave OS data |
| **Base44 Backend** | `b44_entity_list`, `b44_entity_create`, `b44_entity_update`, `b44_entity_delete`, `b44_deploy_function`, `b44_get_function_logs` | Entity + function management |
| **Theta GPU Compute** | `theta_compute_start`, `theta_compute_stop`, `theta_compute_status` | Spin up/tear down GPU sessions |
| **Theta AI** | `theta_ai_chat`, `theta_generate_image`, `theta_generate_video`, `theta_list_models`, `theta_get_credits` | AI inference on decentralized GPU |

No other MCP gives you database + backend deployment + GPU compute + AI in one connection.

---

## PART 3: The Demo Prompt

Paste this EXACT prompt into Cursor's AI chat (`Ctrl+L` / `Cmd+L`):

```
I want you to build and deploy an AI-powered code review API using Wave OS. Do everything through MCP tool calls — don't just generate code, actually deploy it. Here's what I need:

1. Create a "CodeReview" entity in my Wave OS app with these fields:
   - code_snippet (string) — the code being reviewed
   - language (string) — programming language
   - review_text (string) — AI-generated review
   - score (number) — quality score 0-100
   - status (string) — "pending" | "reviewed"

2. Deploy a backend function called "reviewCode" that:
   - Takes a code snippet and language as input
   - Sends it to Theta AI for analysis (use the theta_ai_chat tool)
   - Stores the result in the CodeReview entity
   - Returns the review text, score, and record ID

3. After deploying, call the function with this test input:
   - code_snippet: "function add(a, b) { return a + b; }"
   - language: "javascript"

4. Show me the result and confirm the CodeReview record was created.

Do all of this through MCP tool calls. I want to see the entity created, the function deployed, and the AI review returned — all from this chat.
```

### What Cursor Will Do (Tool Call Sequence)

When you paste this prompt, Cursor will make these MCP calls in sequence:

| Step | MCP Tool Called | What Happens | What You See |
|------|-----------------|--------------|---------------|
| 1 | `wave_entity_list` or `b44_entity_list` | Checks existing entities | Entity list returned |
| 2 | `b44_entity_create` (CodeReview) | Creates new entity schema | "Entity 'CodeReview' created" |
| 3 | `b44_deploy_function` (reviewCode) | Deploys backend function | "Function 'reviewCode' deployed" |
| 4 | `theta_ai_chat` | Calls Theta AI with the code snippet | AI review + score returned |
| 5 | `b44_entity_create` (record) | Stores the review in CodeReview | Record saved to database |
| 6 | `b44_entity_list` (CodeReview) | Reads back the stored review | Record confirmed in DB |

---

## PART 4: Video Script (90 Seconds)

### Recording Setup
- **Screen:** 1920x1080, hide bookmarks bar, clean desktop
- **Browser:** Have oswave.io open in one tab (showing the data explorer)
- **Cursor:** Fresh window, no other files open, dark theme
- **Audio:** Speak clearly, slightly slower than normal

---

### SCENE 1 — The Hook (0:00-0:10)

**Camera:** Cursor AI chat panel, empty

**Narration:**
"What if I could build and deploy a full-stack AI app — database, backend, GPU compute — without ever leaving my IDE? Watch this."

**Action:** Type the demo prompt (from Part 3) into Cursor's chat. Don't hit Enter yet — let the audience read it for 3 seconds.

---

### SCENE 2 — Database Created (0:10-0:25)

**Camera:** Cursor AI chat, showing the MCP tool call happening

**Narration:**
"I'm using the Wave Compute MCP — it connects Cursor directly to Wave OS, which runs on Base44's backend. First, Cursor creates a CodeReview entity in my database. Not SQL — not a migration file — an actual table, right now, through MCP."

**Action:** Cursor calls `b44_entity_create`. Show the tool call in the chat panel (Cursor displays MCP tool calls with their arguments).

**On-Screen Callout:** "✅ Entity 'CodeReview' created — 5 fields"

**Action:** Quickly switch to the oswave.io browser tab showing the data explorer → CodeReview entity appears in the sidebar.

---

### SCENE 3 — Backend Deployed (0:25-0:40)

**Camera:** Back to Cursor, showing the next MCP call

**Narration:**
"Now Cursor deploys a backend function — not to a file, not to a repo — directly to production. The function routes code snippets to Theta AI for analysis and stores results in our entity."

**Action:** Cursor calls `b44_deploy_function` with the full reviewCode function code.

**On-Screen Callout:** "✅ Function 'reviewCode' deployed to oswave.io/api/functions/reviewCode"

**Narration:**
"That's live. No build step. No deploy pipeline. The function is running right now."

---

### SCENE 4 — Theta AI on Decentralized GPU (0:40-0:55)

**Camera:** Cursor chat, showing the AI call

**Narration:**
"Now the moment that makes this special — Cursor calls Theta AI running on decentralized GPU compute. Not AWS. Not GCP. Theta EdgeCloud — a distributed network of GPUs. The AI analyzes the code, scores it, and stores the result — all through the same MCP connection."

**Action:** Cursor calls `theta_ai_chat` with the test code snippet. Show the Theta AI response coming back.

**On-Screen Callout:** "🧠 Theta AI analyzing code... Score: 95/100"

---

### SCENE 5 — Data Confirmed (0:55-1:10)

**Camera:** Switch to oswave.io data explorer

**Narration:**
"Switch to Wave OS — the CodeReview record is there. The AI review, the score, the code snippet — all stored in our entity. Cursor wrote to our database through MCP."

**Action:** Show the CodeReview record in the data explorer with the review text and score visible.

---

### SCENE 6 — The Reveal (1:10-1:25)

**Camera:** Split screen — Cursor on left, Wave OS on right

**Narration:**
"From one prompt in Cursor: a database table created, a backend function deployed to production, AI analysis on decentralized GPU compute, and the result stored — all through a single MCP connection. This is the Wave Compute MCP — the only MCP that gives developers a cloud operating system from inside their IDE."

**Action:** Show the full chain:
- Cursor chat (left): all 6 MCP tool calls visible
- Wave OS (right): entity + data record + function deployed

---

### SCENE 7 — Logo + CTA (1:25-1:30)

**On-Screen:**
- Wave OS logo (teal/purple)
- "oswave.io"
- "Connect Cursor to Wave OS — 100 free credits"
- "Powered by Base44 + Theta EdgeCloud"

**Narration:**
"Connect Cursor to Wave OS at oswave.io. 100 free credits to start."

---

## PART 5: What Makes This Win

### Base44 Connection (Why the judges care)
- **Entity creation** — Cursor creates a Base44 entity through MCP (not just generating code)
- **Function deployment** — Cursor deploys a Base44 backend function (not just writing it to a file)
- **Data read/write** — Cursor reads and writes to Base44 entities (proving the full-stack loop)
- **Live verification** — the data shows up in oswave.io's data explorer in real-time

### Theta Compute Connection (The "wow" factor)
- **Decentralized GPU** — AI analysis runs on Theta EdgeCloud, not AWS/GCP
- **MCP tool call** — Cursor triggers compute through the same connection as the database
- **No other MCP does this** — GitHub MCP can't spin up GPUs. Slack MCP can't deploy functions. Wave Compute MCP does both.

### The One-Prompt Story
- The entire demo is ONE prompt
- Not "here's how to configure your MCP" — the MCP is already connected
- Not "here's the code I wrote" — Cursor writes and deploys it
- Just: "build me this"

### 28 Tools, Zero Overlap
- The Wave Compute MCP provides 28 tools across 6 categories
- It complements Base44's official MCP (which handles app builder features)
- Wave Compute adds the layers Base44 doesn't have: GPU compute, AI inference, Wave OS intelligence

---

## PART 6: Troubleshooting

| Issue | Fix |
|-------|-----|
| Red dot next to wave-compute | Check Authorization header is `Bearer YOUR_TOKEN` (with "Bearer " prefix) |
| 0 tools showing | Make sure type is `http` not `sse`. The mcpRouter uses streamableHTTP |
| "Unauthorized" error | Regenerate your Wave API Token at oswave.io → Settings → Developer |
| Tools show but can't call them | Reload Cursor window (`Ctrl+Shift+P` → "Developer: Reload Window") |
| Connection drops intermittently | Direct HTTP to oswave.io is more stable than any proxy. Ensure you're hitting `https://oswave.io/api/functions/mcpRouter` directly |

---

## Quick Reference

| Item | Value |
|------|-------|
| MCP Server Name | `wave-compute` |
| URL | `https://oswave.io/api/functions/mcpRouter` |
| Type | `http` |
| Auth Header | `Authorization: Bearer YOUR_WAVE_API_TOKEN` |
| Tool Count | 28 |
| Signup URL | oswave.io |
| Demo Entity | CodeReview |
| Demo Function | reviewCode |
| Deadline | July 28, 2026 |

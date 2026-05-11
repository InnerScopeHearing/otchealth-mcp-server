# START HERE: OTCHealth MCP Server Build (Windows)

Updated for Windows + Claude Desktop's built-in Code tab. Customer.io credentials are already populated in `.env.example`. Total active time: about 5 minutes of your work, then mostly hands-off build time.

---

## What you are about to do

1. Make sure Git for Windows is installed (one-time prerequisite)
2. Unzip this scaffold somewhere on your PC
3. Click the Code tab in Claude Desktop (the app you're using right now)
4. Open a new session on the scaffold folder
5. Paste one prompt and let Claude Code build everything

---

## STEP 1: Prerequisite check (Git for Windows)

The Code tab in Claude Desktop requires Git for Windows on first use.

**Quick check:** Open Start menu, type "Git Bash". If it appears, you're set. Skip to Step 2.

**If not installed:**
1. Open Edge or Chrome
2. Go to: https://git-scm.com/download/win
3. Download the 64-bit installer
4. Run it. Click Next through all the default options. It is safe to accept defaults.
5. After install completes, fully quit Claude Desktop (right-click the tray icon, Quit) and reopen it.

---

## STEP 2: Unzip this scaffold

1. Open File Explorer, find the zip in Downloads
2. Right-click the zip, choose "Extract All..."
3. In the dialog, change the destination if you want (suggested: `C:\Users\<your name>\Documents\Projects\`). Click Extract.
4. You should now have a folder named `otchealth-mcp-server`. Remember where it is.

---

## STEP 3: Switch to the Code tab in Claude Desktop

You're currently in the **Chat** tab (talking to me). Look at the top of the Claude Desktop window for tabs. You should see:
- Chat (where you are now)
- Cowork
- **Code** ← click this

If you don't see the Code tab, you may need to update Claude Desktop. Go to Help → Check for Updates.

---

## STEP 4: Open a new session on the scaffold folder

1. Inside the Code tab, click **+ New session** (or press Ctrl+N)
2. When it asks for a folder, navigate to where you extracted the scaffold and select `otchealth-mcp-server`
3. Claude Code may ask permission to access the folder. Approve.

You should now see the scaffold files in the Code tab sidebar.

---

## STEP 5: Paste the kickoff prompt

1. In the Code tab sidebar, click `KICKOFF_PROMPT.md` to open it in the file viewer
2. Scroll down past the explanation, find the line `(===START COPY HERE===)`
3. Select everything from the line BELOW that marker down to the line ABOVE `(===END COPY HERE===)`
4. Copy with Ctrl+C
5. Click into the chat input at the bottom of the Code tab
6. Paste with Ctrl+V
7. Press Enter to send

Claude Code will start by reading the ADR, the Perplexity spec, and the pre-populated `.env.example`. Then it generates three random tokens, finalizes `.env`, and begins the build.

---

## STEP 6: Two moments where Claude Code will ask you something

**Moment 1 (~1 minute into the build): Permission to write new tokens back to Notion.**
Claude Code will generate three new security tokens for the MCP server and ask if it can save them to your Notion Token Vault under a new "OTCHealth MCP Server" section. Say yes. This preserves them so future sessions can find them.

**Moment 2 (later, around Step 5): n8n and GitHub credentials.**
Claude Code will need your n8n API key (Step 5) and GitHub PAT (Step 6). Both are already in your Notion vault. If Claude Code can reach Notion directly, it pulls them automatically. If not, it will ask you to paste the n8n section (or GitHub section) from your vault into the chat. Two pastes maximum.

Your Notion Token Vault is at: https://www.notion.so/35220e2667bc81e2b591fb1f641473f8

---

## STEP 7: What to do while Claude Code builds

Most of the build is hands-off. Claude Code will sometimes ask to approve actions like:
- Installing dependencies (npm install)
- Creating files
- Committing to git
- Pushing to GitHub
- Connecting to Railway

Default answer: yes, approve.

The three specific moments that need real input:

**A. GitHub push.** Claude Code will push to the GBGolfMatt account using the PAT from your vault. Repo name: `otchealth-mcp-server`. Private repo. Approve.

**B. Railway sign-in.** Claude Code will tell you to log into Railway. Go to https://railway.app and sign up if you have not. Free tier is fine. Connect your GitHub when prompted.

**C. Perplexity connector setup.** Claude Code will give you a URL and a token. Steps:
1. Open Perplexity (web or desktop), click your profile icon, Settings, Connectors
2. Click "Add custom connector", choose "Remote"
3. Paste the URL Claude Code gives you
4. Choose API key auth, paste the PERPLEXITY_CONNECTOR_TOKEN value
5. Save

Then in a Perplexity chat: "List the most recent newsletters in Customer.io." If it returns your real newsletters, the connector is live.

---

## If something breaks

Paste the exact error message into the Code tab chat. Claude Code will fix it.

If Claude Code itself crashes or refuses to start:
- Quit Claude Desktop fully (right-click tray icon, Quit) and reopen
- Confirm Git for Windows is installed
- Official troubleshooting: https://docs.claude.com/en/docs/claude-code/troubleshooting

If you get genuinely stuck and need to ask me (back in the Chat tab) for help, send:
1. What you were trying to do
2. The exact error
3. What you have tried

---

## When you are done

Claude Code will tell you Phase 1 is live. You should have:
- A live HTTPS URL serving the MCP endpoint
- 9 Customer.io read tools working against workspace 193366
- 2 simple write tools (track event, update attributes) in dry-run mode
- Audit logging active
- A README with operator playbook
- Three new security tokens saved to your Notion vault
- A short note from Claude Code: what is live, what is safe, what is still risky

Forward that note back to me in the Chat tab and we'll decide what to enable next.

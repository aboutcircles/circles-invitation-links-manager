# Invitation Manager — User Flows

## Overview

The Invitation Manager is a miniapp that runs inside the Circles miniapp iframe. It lets you manage invitation links for onboarding new users. There are two main tabs: **Distributions** (managing batches of invite links accessible via the "invitation distribution link") and **My Invitation Codes** (your personal pool of raw invite keys).

---

## 1. Signing In

**Who:** Anyone who opens the app.

1. The app detects your connected wallet automatically.
2. Click **Sign in** — the app requests a challenge from the auth server.
3. Your wallet asks you to sign a message (no gas, no transaction).
4. Once signed, you're logged in and land on the **Distributions** tab.

To sign out, scroll to the bottom of any tab and click **Sign out**.

---

## 2. Distributions Tab

### 2a. Viewing Distributions

- All your distribution sessions load automatically when you sign in.
- Each card shows: the label, status (active / paused / expired), claimed vs. total invite count, and the assigned group (if any).
- Click a card to open its detail view.

---

### 2b. Creating a New Distribution

1. Click **+ New** in the top-right of the Distributions tab.
2. Enter a **label** (e.g. "ETHDenver booth #3").
3. Choose an **expiry**: Never, 1 day, 7 days, or 30 days — after which the distribution link becomes inactive. You can also pause it manually at any time.
4. Click **Create Session**.

The new distribution appears in the list immediately.

---

### 2c. Distribution Detail

Click any distribution card to open its detail view. From here you can:

- See **claimed / total** invite count inline next to the "Invites" heading.
- **Copy the invite link** — the link goes to `circles.gnosis.io/invitation/...` and is what you share with new users.
- **Add custom URL params** (e.g. UTM tags) via the "GET params" button — they get appended to the copied link automatically.
- **Pause / Resume** the session using the ⏸ / ▶ button in the top-right corner.
- **Refresh** the session data using the ↻ button in the top-right corner.
- **Assign a group** (see section 2d).
- **Generate new invite codes** if you have quota (see section 2e).
- **Add keys manually** (see section 2f).
- **Reassign or remove individual keys** from the keys list.

---

### 2d. Assigning a Group to a Distribution

Assigning a group means all invite accounts in this session will be **trusted** by that Circles group, making new users full group members on onboarding.

1. In the distribution detail, click the group name (or "No group" if none is set).
2. A modal opens listing all groups you control (admin or service).
3. Click a group to assign it.
   - All existing invite accounts in the session are trusted in the group (in batches of up to 30 per transaction).
4. To remove the group, click the group name again and choose **No group**.
   - All invite accounts are untrusted from the group.

**Note:** Changing from one group to another untrusts from the old group and trusts into the new one automatically.

---

### 2e. Generating New Invite Codes (with Quota)

This option appears only if you have available quota from the InvitationFarm contract.

1. In the distribution detail, a green **Quota: N** bar appears at the top.
2. Set how many invites to create (1–10) using the number input.
3. Click the **＋** button.
4. Your wallet prompts you to approve **two transactions**:
   - First: claim invite slots from the InvitationFarm contract.
   - Second: transfer the resulting invite tokens to the session's holding address.
5. The new keys are added to the session automatically.
6. The quota counter updates to reflect what was used.

---

### 2f. Adding Keys Manually

Use this when you have raw private keys (e.g. generated externally) that you want to add to a session.

1. In the distribution detail, scroll to the bottom and click **+ Add keys manually**.
2. Paste private keys — one per line, each in `0x` + 64 hex character format.
3. Click **Add Keys**.
4. The keys are stored on the server and appear in the keys list.

---

### 2g. Reassigning or Removing a Key

Each key row in the keys list has two actions:

- **Move →** opens a modal to move that key to a different distribution session.
- **Remove** deletes the key from the current session.

---

## 3. My Invitation Codes Tab

This tab shows your personal pool of invite keys — keys that exist in the system but haven't been assigned to any distribution session yet.

### 3a. Viewing Your Codes

- All your unassigned invitation codes load automatically (in batches of 50 until fully loaded).
- Claimed keys are shown in a collapsed "Claimed" section at the bottom.

---

### 3b. Storing New Keys to Your Pool

1. Click **+ Add Keys** in the top-right.
2. Paste private keys — one per line (`0x` + 64 hex chars).
3. Click **Store Keys**.

The keys are stored on the server and appear in your pool.

---

### 3c. Assigning Codes to a Distribution Session

1. Check the checkbox next to any invite code(s) you want to assign.
   - Or use **Select all** to select every code on screen.
2. Once at least one is selected, an **Assign to session →** button appears in the select-all row.
3. Click it — a modal lists your available distribution sessions.
4. Click a session to assign the selected codes to it.

---

## 4. Invite Link Flow (End User)

This is what happens when someone receives an invite link:

1. A new user opens the link: `https://circles.gnosis.io/invitation/<session-slug>/<invitation-code>`
2. The Circles app registers them using the pre-funded invite account.
3. If the distribution has a group assigned, the user is trusted by that group automatically.
4. The key status changes to **claimed** in the manager.

---

## Quick Reference

| Action | Where |
|--------|-------|
| Sign in / out | Auth screen / bottom of any tab |
| Create distribution | Distributions tab → + New |
| Copy invite link | Distribution detail → copy link button |
| Generate invites (quota) | Distribution detail → green quota bar → ＋ |
| Add keys manually | Distribution detail → + Add keys manually |
| Assign group | Distribution detail → click group name |
| Pause / resume session | Distribution detail → ⏸ / ▶ (top-right) |
| Move key to another session | Keys list → Move → |
| Store keys to pool | My Invitation Codes tab → + Add Keys |
| Assign pool keys to session | My Invitation Codes tab → select → Assign to session → |

# Subscriptions and license keys

A **subscription** says what the client bought. A **license key** is the signed file that lets their MyWineCorks run with those terms.

## 1. Add a subscription

On the client page press **New subscription**:

- **Plan** — the plan name, e.g. *Cellar*, *Merchant*.
- **Hosting** — *Self-hosted* (their own PC, Mac or NAS) or *Cloud* (our server).
- **Modules** — **Cellar** (always), **Customer portal**, **AI assistant**.
- **Limits** — bottles, orders per month and users. Blank = no limit.
- **Billing** (year or month), **Price**, **Currency**, **Starts** and **Renews** dates.

## 2. Issue the license key

Press **Issue license key**. The key carries the modules, limits and expiry of the subscription, and is signed so it cannot be changed. Give it to the client in one of three ways:

- **Email to client** — sends the key to the client's email in their language.
- **Show key** › **Copy** — to send it yourself (e.g. by LINE).
- **Download file** — a license file.

> Treat a key like a password. The Owner pastes it in **Settings › License** and presses **Activate**. The first server that activates a key is bound to it.

For **Cloud** subscriptions, use **Cloud workspaces** instead: it creates the workspace and its license in one step.

## How a license behaves on the client's server

- **Trial** — a new installation without a key runs for **14 days**, then locks.
- **Daily check-in** — the server contacts HQ once a day. After **7 days** without contact it shows a warning; after **30 days** it locks.
- **Expiry and grace** — after the expiry date the server keeps working for the **grace period** (14 days unless changed), with a warning, then locks.
- **Locked** — the client can still sign in and export all their data; nothing is ever deleted. It unlocks as soon as a valid key arrives.

## Renewing

Press **Renew** on the license and choose the **New expiry date**. The client does nothing: their server picks up the renewed key at its next daily check-in. Clients get renewal reminder emails **30, 14, 7 and 1 day** before expiry.

## Other actions

- **Grace period** — change the number of days (0–90) for this license.
- **Move to new server** — when a client replaces their computer. Unbinds the key; the old server locks at its next check-in and the client activates the new one with the same key. At most **2 moves a year** (a Super Admin can do more). Not for cloud licenses.
- **Revoke** — Super Admin only. The client's server locks at its next check-in. This cannot be undone; issue a new key if needed.

Revoking asks for a reason. Every action is written to the client's history and the audit log.

# Cloud workspaces

Clients who do not want their own server use our cloud. Each client gets a **workspace** on the cloud server.

## Creating a workspace

1. On the client page, add a subscription with **Hosting: Cloud**.
2. Go to **Cloud workspaces** and press **Create cloud workspace**.
3. Choose the subscription and fill in the **Workspace ID** (lower-case letters, numbers and dashes — the client types it when signing in), the **Owner's email** and the **Owner's name**.
4. Press **Create**. HQ creates the workspace with its license and emails the Owner a setup link. The **Owner setup link** is also shown on screen (valid 7 days, works once) so you can send it yourself.

The list shows each workspace with its license state (**Trial**, **Active**, **Grace period**, **Locked**). If the Owner loses the link, reissue it from the list.

> If the page says no cloud server is set up, HQ's settings are missing `CLOUD_URL` and `CLOUD_PROVISION_TOKEN` — ask the developer.

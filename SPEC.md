# Product specification

The hub provides a browser view of named Claude Code sessions running in Zellij on a separate machine. The agent connects outward to the hub over WebSocket and authenticates with a shared secret. The browser signs in to the hub and opens a live terminal through the agent.

Sessions remain on the agent machine. The hub stores the folder tree and browser sessions in a local database. The agent controls session creation, rename, hibernation, wake, deletion, file transfer, usage meters, and status.

A production deployment needs an HTTPS reverse proxy, a persistent hub data directory, and an agent with access to Zellij and the maxclaude session tools. Keep the browser interface on a private network or behind authentication. See README.md for setup and PROTOCOL.md for the wire contract.

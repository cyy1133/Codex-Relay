# Codex Relay

Remote dashboard for controlling the local Codex CLI from another device.

## Features

- Reads local Codex session files and shows thread history.
- Displays only visible user and assistant messages.
- Queues `codex exec` for new threads and `codex exec resume` for existing threads.
- Sends completion or failure alerts to Discord.
- Adds deep links to a specific thread in dashboard notifications.

## Run

```bat
node server.mjs
```

Manual background start:

```bat
start-dashboard.cmd
```

Install Windows Startup entry:

```bat
install-startup.cmd
```

Remove Windows Startup entry:

```bat
remove-startup.cmd
```

When the server starts, it prints:

- the local URL
- the LAN URL
- the access token
- the settings file path

## Settings

Runtime settings are stored in `data/settings.json` and are ignored by git.

Supported settings:

- `defaultWorkspaceRoot`
- `publicBaseUrl`
- `notificationEnabled`
- `discordWebhookUrl`
- `discordBotToken`
- `discordChannelId`

Discord bot delivery needs both `discordBotToken` and `discordChannelId`.
If you prefer, you can use `discordWebhookUrl` instead.

`publicBaseUrl` is used to build the thread link included in Discord alerts.
Example:

```text
http://your-hostname:3210
```

## External Access

Using `your-hostname:3210` only works if all of these are true:

- the domain points to this machine or your router
- port `3210` is open on the firewall
- port forwarding or reverse proxy is configured correctly

If you want a cleaner public URL, put this server behind a reverse proxy or a tunnel.

## Security

- This dashboard can execute local Codex jobs, so treat the access token as sensitive.
- Do not expose the port directly to the public internet unless you understand the risk.
- Prefer LAN, VPN, Tailscale, or a protected reverse proxy.

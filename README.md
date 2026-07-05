# Echo Whispers Server

Echo Whispers Server is a local REST bridge for Amazon Echo / Alexa devices.

It provides a small web UI and REST API for:

- Amazon login and cookie refresh
- Loading Echo devices
- Speaking text on a selected Echo
- Optional volume control before speaking
- Optional restore-volume behavior after speaking
- Announcements
- Hubitat / Echo Speaks compatibility endpoints

The server is designed to run on Linux-like systems, including Raspberry Pi, Ubuntu, Debian, Proxmox containers, small home servers, or similar always-on machines.

---

## Important Security Notes

Do not commit your real `config.json` file to GitHub.

`config.json` can contain Amazon cookies, refresh tokens, CSRF tokens, API keys, and Hubitat callback URLs.

A good `.gitignore` should include:

```gitignore
node_modules
config.json
.env
*.log
.DS_Store
```

If you enable an API key, API requests must include it by either:

```text
?apiKey=YOUR_API_KEY
```

or:

```text
x-api-key: YOUR_API_KEY
```

---

## Requirements

- Linux, Raspberry Pi OS, Ubuntu, Debian, or similar
- Node.js 18 or newer
- npm
- Network access from your browser to the server
- Amazon account with Echo devices

Recommended:

- Node.js 20 LTS or newer
- systemd for running as a background service

---

## Install Node.js

### Debian / Ubuntu / Raspberry Pi OS

Check if Node is already installed:

```bash
node -v
npm -v
```

If Node is missing or too old, install Node.js LTS using NodeSource:

```bash
sudo apt update
sudo apt install -y curl ca-certificates gnupg
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

Verify:

```bash
node -v
npm -v
```

You should see Node 20.x or newer.

---

## Clone the Repository

```bash
cd /opt
sudo git clone https://github.com/bloodtick/echo-whispers-server.git
sudo chown -R $USER:$USER /opt/echo-whispers-server
cd /opt/echo-whispers-server
```

If you prefer running it from your home folder:

```bash
cd ~
git clone https://github.com/bloodtick/echo-whispers-server.git
cd echo-whispers-server
```

---

## Install Dependencies

```bash
npm install
```

---

## Start the Server

```bash
npm start
```

Or directly:

```bash
node server.js
```

Default ports:

```text
Web UI / API: 8585
Amazon Login Proxy: 8586
```

Open the UI:

```text
http://YOUR_SERVER_IP:8585/
```

Example:

```text
http://10.0.0.117:8585/
```

---

## First-Time Setup

1. Open the Echo Whispers web UI.
2. Click `Amazon Login`.
3. Complete the Amazon login flow in the popup window.
4. Return to the Echo Whispers UI.
5. Confirm that cookie, CSRF, and device registration fields populate.
6. Click `Load Devices`.
7. Pick an Echo device.
8. Type a message.
9. Click `Speak`.

---

## Configuration

Echo Whispers stores persistent settings in:

```text
config.json
```

By default, it is created in the same directory as `server.js`.

You can override that path:

```bash
CONFIG_FILE=/opt/echo-whispers-server/config/config.json node server.js
```

Common environment variables:

```bash
PORT=8585
PROXY_PORT=8586
CONFIG_FILE=/opt/echo-whispers-server/config.json
API_KEY=your-api-key
AMAZON_PAGE=amazon.com
ACCEPT_LANGUAGE=en-US,en;q=0.9
ALEXA_SERVICE_HOST=pitangui.amazon.com
AMAZON_PAGE_PROXY_LANGUAGE=en_US
```

Example:

```bash
PORT=8585 PROXY_PORT=8586 node server.js
```

---

## Run as a systemd Service

Create a service file:

```bash
sudo nano /etc/systemd/system/echo-whispers.service
```

Paste this:

```ini
[Unit]
Description=Echo Whispers Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/echo-whispers-server
ExecStart=/usr/bin/node /opt/echo-whispers-server/server.js
Restart=always
RestartSec=5
User=YOUR_LINUX_USER
Group=YOUR_LINUX_USER
Environment=PORT=8585
Environment=PROXY_PORT=8586
Environment=CONFIG_FILE=/opt/echo-whispers-server/config.json

[Install]
WantedBy=multi-user.target
```

Replace:

```text
YOUR_LINUX_USER
```

with your actual Linux username.

Find it with:

```bash
whoami
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable echo-whispers
sudo systemctl start echo-whispers
```

Check status:

```bash
sudo systemctl status echo-whispers
```

View logs:

```bash
journalctl -u echo-whispers -f
```

Restart after changes:

```bash
sudo systemctl restart echo-whispers
```

---

## Updating

```bash
cd /opt/echo-whispers-server
git pull
npm install
sudo systemctl restart echo-whispers
```

If you run manually:

```bash
cd /opt/echo-whispers-server
git pull
npm install
node server.js
```

---

# API Usage

Set a base URL for examples:

```bash
BASE_URL="http://YOUR_SERVER_IP:8585"
```

Example:

```bash
BASE_URL="http://10.0.0.117:8585"
```

If API Key is enabled:

```bash
API_KEY="YOUR_API_KEY"
```

Use it as a header:

```bash
-H "x-api-key: $API_KEY"
```

or as a query parameter:

```text
?apiKey=YOUR_API_KEY
```

---

## Status

### `GET /health`

Basic health check.

```bash
curl -s "$BASE_URL/health"
```

### `GET /api/status`

Returns runtime status, cookie status, device count, Hubitat status, and config visibility.

```bash
curl -s "$BASE_URL/api/status"
```

With API key:

```bash
curl -s "$BASE_URL/api/status" \
  -H "x-api-key: $API_KEY"
```

---

## Config

### `GET /api/config`

Returns current configuration and status.

```bash
curl -s "$BASE_URL/api/config" \
  -H "x-api-key: $API_KEY"
```

### `POST /api/config`

Updates configuration.

```bash
curl -s -X POST "$BASE_URL/api/config" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{
    "port": 8585,
    "proxyPort": 8586,
    "deviceAppName": "Echo Whispers",
    "amazonPage": "amazon.com",
    "acceptLanguage": "en-US,en;q=0.9",
    "amazonPageProxyLanguage": "en_US",
    "alexaServiceHost": "pitangui.amazon.com",
    "apiKey": "new-api-key"
  }'
```

Clear the API key:

```bash
curl -s -X POST "$BASE_URL/api/config" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{
    "apiKey": ""
  }'
```

---

## Amazon Login and Auth

### `POST /api/login/start`

Starts the Amazon Login proxy flow.

```bash
curl -s -X POST "$BASE_URL/api/login/start" \
  -H "x-api-key: $API_KEY"
```

The response includes a `proxyUrl`. Open that URL in a browser to complete Amazon Login.

### `POST /api/auth/refresh-cookie`

Refreshes the Amazon cookie using the saved refresh token.

```bash
curl -s -X POST "$BASE_URL/api/auth/refresh-cookie" \
  -H "x-api-key: $API_KEY"
```

### `POST /api/auth/full-reauth`

Starts a full re-authentication flow.

```bash
curl -s -X POST "$BASE_URL/api/auth/full-reauth" \
  -H "x-api-key: $API_KEY"
```

### `POST /api/init`

Initializes or reinitializes the Alexa runtime.

```bash
curl -s -X POST "$BASE_URL/api/init" \
  -H "x-api-key: $API_KEY"
```

### `POST /api/clear`

Clears saved login/auth data.

```bash
curl -s -X POST "$BASE_URL/api/clear" \
  -H "x-api-key: $API_KEY"
```

---

## Devices

### `GET /api/devices`

Returns Alexa devices.

```bash
curl -s "$BASE_URL/api/devices" \
  -H "x-api-key: $API_KEY"
```

### `GET /api/devices/:serialNumber`

Returns one device by serial number.

```bash
curl -s "$BASE_URL/api/devices/G6G236093082061K" \
  -H "x-api-key: $API_KEY"
```

### `GET /api/devices/:serialNumber/status`

Returns status for one device.

```bash
curl -s "$BASE_URL/api/devices/G6G236093082061K/status" \
  -H "x-api-key: $API_KEY"
```

---

## Speak

### `GET /api/speak`

Speaks text on the selected/default Echo device.

Common query parameters:

```text
text
serialNumber
deviceType
volume
restoreVolume
apiKey
```

Speak using the default device:

```bash
curl -s "$BASE_URL/api/speak?text=Hello%20from%20Echo%20Whispers" \
  -H "x-api-key: $API_KEY"
```

Speak to a specific device:

```bash
curl -s "$BASE_URL/api/speak?text=Hello&serialNumber=G6G236093082061K&deviceType=A11QM4H9HGV71H" \
  -H "x-api-key: $API_KEY"
```

Speak at volume 35 and then restore the original volume:

```bash
curl -s "$BASE_URL/api/speak?text=Hello&serialNumber=G6G236093082061K&deviceType=A11QM4H9HGV71H&volume=35&restoreVolume=true" \
  -H "x-api-key: $API_KEY"
```

Browser-friendly GET example:

```text
http://YOUR_SERVER_IP:8585/api/speak?text=Hello&serialNumber=G6G236093082061K&deviceType=A11QM4H9HGV71H&volume=35&restoreVolume=true&apiKey=YOUR_API_KEY
```

### `GET /api/speak/:serialNumber`

Speaks text using the serial number in the path.

```bash
curl -s "$BASE_URL/api/speak/G6G236093082061K?text=Hello&deviceType=A11QM4H9HGV71H&volume=35&restoreVolume=true" \
  -H "x-api-key: $API_KEY"
```

### `POST /api/speak`

POST version of speak.

```bash
curl -s -X POST "$BASE_URL/api/speak" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{
    "serialNumber": "G6G236093082061K",
    "deviceType": "A11QM4H9HGV71H",
    "text": "Hello from Echo Whispers",
    "volume": 35,
    "restoreVolume": true
  }'
```

### `POST /api/speak/:serialNumber`

POST speak using serial number in the path.

```bash
curl -s -X POST "$BASE_URL/api/speak/G6G236093082061K" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{
    "deviceType": "A11QM4H9HGV71H",
    "text": "Hello from Echo Whispers",
    "volume": 35,
    "restoreVolume": true
  }'
```

---

## Volume

### `GET /api/volume`

Sets volume on a selected/default device.

```bash
curl -s "$BASE_URL/api/volume?serialNumber=G6G236093082061K&deviceType=A11QM4H9HGV71H&level=35" \
  -H "x-api-key: $API_KEY"
```

### `GET /api/volume/:serialNumber`

```bash
curl -s "$BASE_URL/api/volume/G6G236093082061K?deviceType=A11QM4H9HGV71H&level=35" \
  -H "x-api-key: $API_KEY"
```

### `POST /api/volume`

```bash
curl -s -X POST "$BASE_URL/api/volume" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{
    "serialNumber": "G6G236093082061K",
    "deviceType": "A11QM4H9HGV71H",
    "level": 35
  }'
```

### `POST /api/volume/:serialNumber`

```bash
curl -s -X POST "$BASE_URL/api/volume/G6G236093082061K" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{
    "deviceType": "A11QM4H9HGV71H",
    "level": 35
  }'
```

Volume value is clamped to:

```text
0-100
```

---

## Announcements

### `GET /api/announce`

Sends an announcement to selected devices.

```bash
curl -s "$BASE_URL/api/announce?devices=G6G236093082061K,GK61B505240503EQ&text=Hello%20everyone&title=Echo%20Whispers" \
  -H "x-api-key: $API_KEY"
```

### `GET /api/announce/all`

Sends an announcement to all announcement-capable Echo devices.

```bash
curl -s "$BASE_URL/api/announce/all?text=Hello%20everyone&title=Echo%20Whispers" \
  -H "x-api-key: $API_KEY"
```

### `POST /api/announce`

```bash
curl -s -X POST "$BASE_URL/api/announce" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{
    "devices": [
      { "serialNumber": "G6G236093082061K" },
      { "serialNumber": "GK61B505240503EQ" }
    ],
    "text": "Hello everyone",
    "title": "Echo Whispers"
  }'
```

### `POST /api/announce/all`

```bash
curl -s -X POST "$BASE_URL/api/announce/all" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{
    "text": "Hello everyone",
    "title": "Echo Whispers"
  }'
```

---

## Hubitat / Echo Speaks Compatibility

Echo Whispers includes compatibility endpoints for Echo Speaks style integrations.

### `GET /wakeup`

```bash
curl -s "$BASE_URL/wakeup"
```

### `POST /wakeup`

```bash
curl -s -X POST "$BASE_URL/wakeup"
```

### `GET /refreshCookie`

```bash
curl -s "$BASE_URL/refreshCookie"
```

### `POST /refreshCookie`

```bash
curl -s -X POST "$BASE_URL/refreshCookie"
```

### `GET /clearAuth`

```bash
curl -s "$BASE_URL/clearAuth"
```

### `POST /clearAuth`

```bash
curl -s -X POST "$BASE_URL/clearAuth"
```

---

## Hubitat Management API

### `GET /api/hubitat/status`

Returns Hubitat integration status.

```bash
curl -s "$BASE_URL/api/hubitat/status" \
  -H "x-api-key: $API_KEY"
```

### `POST /api/hubitat/config`

Configures Hubitat compatibility.

```bash
curl -s -X POST "$BASE_URL/api/hubitat/config" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{
    "hubitatCompatEnabled": true,
    "hubitatCallbackUrl": "https://cloud.hubitat.com/api/YOUR_APP/receiveData?access_token=YOUR_TOKEN",
    "hubitatServerUrl": "http://YOUR_SERVER_IP:8585/",
    "echoSpeaksVersion": "4.3.0.1"
  }'
```

### `POST /api/hubitat/send-server-data`

Sends server info to Hubitat.

```bash
curl -s -X POST "$BASE_URL/api/hubitat/send-server-data" \
  -H "x-api-key: $API_KEY"
```

### `POST /api/hubitat/send-cookie`

Sends the current Amazon cookie to Hubitat.

```bash
curl -s -X POST "$BASE_URL/api/hubitat/send-cookie" \
  -H "x-api-key: $API_KEY"
```

### `POST /api/hubitat/pull-cookie`

Pulls cookie data from Hubitat if supported/configured.

```bash
curl -s -X POST "$BASE_URL/api/hubitat/pull-cookie" \
  -H "x-api-key: $API_KEY"
```

### `DELETE /api/hubitat/cookie`

Clears the Hubitat-side cookie through the configured callback flow.

```bash
curl -s -X DELETE "$BASE_URL/api/hubitat/cookie" \
  -H "x-api-key: $API_KEY"
```

---

## Common API Parameters

Device lookup accepts several common aliases:

```text
serialNumber
deviceSerialNumber
serial

deviceType
deviceTypeId
type

device
deviceName
name
accountName
friendlyName
```

Speak text accepts:

```text
text
message
speech
```

Volume accepts:

```text
volume
level
volumeLevel
```

Restore volume accepts:

```text
restoreVolume
restore
returnVolume
```

Announcement device selection accepts:

```text
devices
deviceList
serialNumbers
serialNumber
deviceSerialNumber
serial
device
name
all=true
```

---

## Troubleshooting

### UI buttons do not work after setting API Key

Refresh the page and make sure the API Key field contains the key.

The UI sends the key as:

```text
x-api-key
```

The clickable GET examples can also include:

```text
?apiKey=YOUR_API_KEY
```

### Cannot clear API Key

Leave the API Key field blank and click `Save Settings`.

The UI will authorize that save using the prior key.

### Devices do not load

Try:

```bash
curl -s "$BASE_URL/api/status" \
  -H "x-api-key: $API_KEY"
```

Then refresh the cookie:

```bash
curl -s -X POST "$BASE_URL/api/auth/refresh-cookie" \
  -H "x-api-key: $API_KEY"
```

If needed, perform Amazon Login again from the UI.

### Port already in use

Check what is using port 8585:

```bash
sudo lsof -i :8585
```

Use another port:

```bash
PORT=8595 PROXY_PORT=8596 node server.js
```

### View service logs

```bash
journalctl -u echo-whispers -f
```

---

## Development

Run locally:

```bash
npm install
node server.js
```

Check syntax:

```bash
node --check server.js
```

Common Git update flow:

```bash
git status
git add .
git commit -m "Update Echo Whispers"
git push
```

---

## License

Add your preferred license here.

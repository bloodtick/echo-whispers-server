# Echo Whispers Server

Echo Whispers Server is a local REST bridge for Amazon Echo / Alexa devices.

It provides a small web UI and REST API for:

- Amazon login and cookie refresh
- Discovering Echo devices and checking device status
- Speaking text on a selected Echo
- Optional volume control and restore-volume behavior when speaking
- Announcements to one, multiple, or all available Echo devices
- Hubitat / Echo Speaks compatibility endpoints

**Speak** sends text-to-speech to an individual Echo. **Announce** sends one Amazon announcement request for the selected devices and excludes devices reported offline. Announcements may play the usual Alexa announcement chime.

The server is designed to run on Linux-like systems, including Raspberry Pi, Ubuntu, Debian, Proxmox containers, small home servers, or similar always-on machines.

---

## Requirements

- Linux, Raspberry Pi OS, Ubuntu, Debian, or similar
- Node.js 18 or newer
- npm
- Network access from your browser to the server
- Amazon account with Echo devices

Recommended:

- Node.js 20 LTS or newer
- PM2 for running as a background service

---

## Install Node.js

### Debian / Ubuntu / Raspberry Pi OS

Check if Node is already installed:

```bash
node -v
npm -v
```

If Node is missing or too old, install a supported Node.js version. For example, to install Node.js 20 using NodeSource:

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

### Older Raspberry Pi Models

Some older Raspberry Pi models may not support current Node.js packages. Check the CPU architecture and available builds before installing. Node.js 20 or newer is recommended where supported.

---

## Clone the Repository

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

Open the UI:

```text
http://YOUR_SERVER_IP:8585/
```

Example:

```text
http://192.0.2.10:8585/
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

## Regional Settings

Use the following settings for your Amazon/Alexa region:

| Region | Amazon Page | Accept Language | Proxy Language | Alexa Service Host |
|:---|:---|:---|:---|:---|
| US | `amazon.com` | `en-US,en;q=0.9` | `en_US` | `pitangui.amazon.com` |
| UK | `amazon.co.uk` | `en-GB,en;q=0.9` | `en_GB` | `layla.amazon.com` |
| Germany | `amazon.de` | `de-DE,de;q=0.9` | `de_DE` | `layla.amazon.de` |
| France | `amazon.fr` | `fr-FR,fr;q=0.9` | `fr_FR` | `layla.amazon.de` |
| Italy | `amazon.it` | `it-IT,it;q=0.9` | `it_IT` | `alexa.amazon.it` |
| Spain | `amazon.es` | `es-ES,es;q=0.9` | `es_ES` | `alexa.amazon.es` |
| Australia | `amazon.com.au` | `en-AU,en;q=0.9` | `en_AU` | `alexa.amazon.com.au` |
| Brazil | `amazon.com.br` | `pt-BR,pt;q=0.9` | `pt_BR` | `alexa.amazon.com.br` |

---

## Configuration

Echo Whispers stores persistent settings in:

```text
config.json
```

By default, it is created in the same directory as `server.js`.

---

## Run with PM2

PM2 keeps Echo Whispers running in the background and restarts it automatically if it exits.

Install PM2 globally:

```bash
sudo npm install -g pm2
```

Start Echo Whispers:

```bash
cd ~/echo-whispers-server
pm2 start server.js --name echo-whispers
```

Check status:

```bash
pm2 status
```

View logs:

```bash
pm2 logs echo-whispers
```

Restart:

```bash
pm2 restart echo-whispers
```

Stop:

```bash
pm2 stop echo-whispers
```

Delete the PM2 app entry:

```bash
pm2 delete echo-whispers
```

Save the PM2 process list so it can restart after reboot:

```bash
pm2 save
```

Enable PM2 startup on boot:

```bash
pm2 startup
```

PM2 will print a command starting with `sudo env ...`. Copy and run that exact command, then save again:

```bash
pm2 save
```

---

## PM2 Log Rotation

Install the PM2 log rotation module:

```bash
pm2 install pm2-logrotate
```

Recommended settings:

```bash
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:dateFormat YYYY-MM-DD_HH-mm-ss
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
```

What those do:

```text
max_size       Rotate a log file after it reaches 10 MB
retain         Keep 14 rotated logs
compress       Compress old rotated logs
dateFormat     Add date/time to rotated log files
rotateInterval Also rotate once per day at midnight
```

Force a manual rotation:

```bash
pm2 trigger pm2-logrotate rotate
```

PM2 log files are usually under:

```text
~/.pm2/logs/
```

View current log paths:

```bash
pm2 describe echo-whispers
```

---

## Updating

```bash
cd ~/echo-whispers-server
git pull
npm install
pm2 restart echo-whispers
```

If you run manually:

```bash
cd ~/echo-whispers-server
git pull
npm install
node server.js
```

---

# API Usage

Set a base URL for the examples:

```bash
BASE_URL="http://YOUR_SERVER_IP:8585"
```

Example:

```bash
BASE_URL="http://192.0.2.10:8585"
```

If API key authentication is enabled:

```bash
API_KEY="YOUR_API_KEY"
```

Pass the key as a header:

```bash
-H "x-api-key: $API_KEY"
```

Or as a query parameter:

```text
?apiKey=YOUR_API_KEY
```

The examples below omit the key for readability. Add it if your server requires authentication.

---

## Status

### `GET /health`

Basic health check:

```bash
curl -s "$BASE_URL/health"
```

### `GET /api/status`

Returns runtime status, cookie status, device count, Hubitat status, and configuration visibility:

```bash
curl -s "$BASE_URL/api/status"
```

With API key:

```bash
curl -s "$BASE_URL/api/status" -H "x-api-key: $API_KEY"
```

---

## Config

### `GET /api/config`

Returns current configuration and status:

```bash
curl -s "$BASE_URL/api/config" -H "x-api-key: $API_KEY"
```

### `POST /api/config`

Updates configuration:

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
  -d '{"apiKey":""}'
```

---

## Amazon Login and Auth

### `POST /api/login/start`

Starts the Amazon Login proxy flow. Open the returned `proxyUrl` in a browser:

```bash
curl -s -X POST "$BASE_URL/api/login/start" -H "x-api-key: $API_KEY"
```

### `POST /api/auth/refresh-cookie`

Refreshes the Amazon cookie using the saved refresh token:

```bash
curl -s -X POST "$BASE_URL/api/auth/refresh-cookie" -H "x-api-key: $API_KEY"
```

### `POST /api/auth/full-reauth`

Starts a full re-authentication flow:

```bash
curl -s -X POST "$BASE_URL/api/auth/full-reauth" -H "x-api-key: $API_KEY"
```

### `POST /api/init`

Initializes or reinitializes the Alexa runtime:

```bash
curl -s -X POST "$BASE_URL/api/init" -H "x-api-key: $API_KEY"
```

### `POST /api/clear`

Clears saved login/auth data:

```bash
curl -s -X POST "$BASE_URL/api/clear" -H "x-api-key: $API_KEY"
```

---

## Devices

### `GET /api/devices`

Returns discovered Alexa devices. Use this endpoint to find each Echo's serial number and device type:

```bash
curl -s "$BASE_URL/api/devices"
```

### `GET /api/devices/:serialNumber`

Returns one device by serial number:

```bash
curl -s "$BASE_URL/api/devices/YOUR_DEVICE_SERIAL"
```

### `GET /api/devices/:serialNumber/status-lite`

Returns lightweight status, including online/offline state and volume, for one Echo:

```bash
curl -s "$BASE_URL/api/devices/YOUR_DEVICE_SERIAL/status-lite"
```

Browser-friendly URL:

```text
http://YOUR_SERVER_IP:8585/api/devices/YOUR_DEVICE_SERIAL/status-lite
```

Example using a device serial number:

```bash
curl -s "$BASE_URL/api/devices/EXAMPLE_DEVICE_SERIAL/status-lite"
```

Use `status-lite` for regular polling. It checks the requested device's current status without forcing a full discovery on every call. Device discovery is refreshed when needed, at most once per 15 minutes for this path.

### `GET /api/devices/:serialNumber/status`

Returns more detailed device status:

```bash
curl -s "$BASE_URL/api/devices/YOUR_DEVICE_SERIAL/status"
```

Use `status` when you want the broader status information and a device-discovery refresh. Discovery is still subject to the server's 15-minute cache interval.

---

## Speak

Speak sends text-to-speech to an individual Echo device. You can use the configured default Echo or select one by serial number.

### `GET /api/speak`

Speak using the default device:

```bash
curl -G "$BASE_URL/api/speak" \
  --data-urlencode "text=Hello from Echo Whispers"
```

Speak to a specific device:

```bash
curl -G "$BASE_URL/api/speak" \
  --data-urlencode "text=Hello from Echo Whispers" \
  --data-urlencode "serialNumber=YOUR_DEVICE_SERIAL" \
  --data-urlencode "deviceType=YOUR_DEVICE_TYPE"
```

Speak at volume 35 and restore the original volume afterward:

```bash
curl -G "$BASE_URL/api/speak" \
  --data-urlencode "text=Hello from Echo Whispers" \
  --data-urlencode "serialNumber=YOUR_DEVICE_SERIAL" \
  --data-urlencode "deviceType=YOUR_DEVICE_TYPE" \
  --data-urlencode "volume=35" \
  --data-urlencode "restoreVolume=true"
```

Browser-friendly URL:

```text
http://YOUR_SERVER_IP:8585/api/speak?text=Hello%20from%20Echo%20Whispers&serialNumber=YOUR_DEVICE_SERIAL&deviceType=YOUR_DEVICE_TYPE
```

### `GET /api/speak/:serialNumber`

```bash
curl -G "$BASE_URL/api/speak/YOUR_DEVICE_SERIAL" \
  --data-urlencode "text=Hello" \
  --data-urlencode "deviceType=YOUR_DEVICE_TYPE"
```

### `POST /api/speak`

```bash
curl -s -X POST "$BASE_URL/api/speak" \
  -H "Content-Type: application/json" \
  -d '{
    "serialNumber": "YOUR_DEVICE_SERIAL",
    "deviceType": "YOUR_DEVICE_TYPE",
    "text": "Hello from Echo Whispers",
    "volume": 35,
    "restoreVolume": true
  }'
```

### `POST /api/speak/:serialNumber`

```bash
curl -s -X POST "$BASE_URL/api/speak/YOUR_DEVICE_SERIAL" \
  -H "Content-Type: application/json" \
  -d '{
    "deviceType": "YOUR_DEVICE_TYPE",
    "text": "Hello from Echo Whispers",
    "volume": 35,
    "restoreVolume": true
  }'
```

Common Speak parameters:

| Parameter | Description |
|---|---|
| `text` | Text to speak |
| `serialNumber` | Target Echo serial number; omit to use the default device |
| `deviceType` | Target Echo device type |
| `volume` | Optional volume, 0–100 |
| `restoreVolume` | Whether to restore the prior volume after speaking |

---

## Volume

### `GET /api/volume`

Sets volume on a selected/default device:

```bash
curl -G "$BASE_URL/api/volume" \
  --data-urlencode "serialNumber=YOUR_DEVICE_SERIAL" \
  --data-urlencode "deviceType=YOUR_DEVICE_TYPE" \
  --data-urlencode "level=35"
```

### `GET /api/volume/:serialNumber`

```bash
curl -G "$BASE_URL/api/volume/YOUR_DEVICE_SERIAL" \
  --data-urlencode "deviceType=YOUR_DEVICE_TYPE" \
  --data-urlencode "level=35"
```

### `POST /api/volume`

```bash
curl -s -X POST "$BASE_URL/api/volume" \
  -H "Content-Type: application/json" \
  -d '{
    "serialNumber": "YOUR_DEVICE_SERIAL",
    "deviceType": "YOUR_DEVICE_TYPE",
    "level": 35
  }'
```

### `POST /api/volume/:serialNumber`

```bash
curl -s -X POST "$BASE_URL/api/volume/YOUR_DEVICE_SERIAL" \
  -H "Content-Type: application/json" \
  -d '{
    "deviceType": "YOUR_DEVICE_TYPE",
    "level": 35
  }'
```

Volume values are clamped to `0–100`.

---

## Announcements

Announce sends the same message to one, multiple, or all available Echo devices. Unlike sending Speak requests to each device separately, an announcement uses **one Amazon request** containing all selected devices. Devices reported offline are automatically excluded.

Announcements may play the standard Alexa announcement chime. Volume adjustment and restoration are supported by Speak, not by the announcement request.

### `GET /api/announce/all`

Announce to all available announcement-capable Echo devices:

```bash
curl -G "$BASE_URL/api/announce/all" \
  --data-urlencode "text=Hello everyone"
```

Browser URL:

```text
http://YOUR_SERVER_IP:8585/api/announce/all?text=Hello%20everyone
```

### `GET /api/announce`

Announce to one device:

```bash
curl -G "$BASE_URL/api/announce" \
  --data-urlencode "text=Hello from Echo Whispers" \
  --data-urlencode "devices=YOUR_DEVICE_SERIAL"
```

Announce to multiple devices using comma-separated serial numbers:

```bash
curl -G "$BASE_URL/api/announce" \
  --data-urlencode "text=Dinner is ready" \
  --data-urlencode "devices=SERIAL1,SERIAL2,SERIAL3"
```

Browser URL:

```text
http://YOUR_SERVER_IP:8585/api/announce?devices=SERIAL1,SERIAL2&text=Dinner%20is%20ready
```

### `POST /api/announce`

Announce to selected devices using JSON:

```bash
curl -s -X POST "$BASE_URL/api/announce" \
  -H "Content-Type: application/json" \
  -d '{
    "devices": [
      {"serialNumber": "SERIAL1"},
      {"serialNumber": "SERIAL2"}
    ],
    "text": "Dinner is ready",
    "title": "Echo Whispers"
  }'
```

### `POST /api/announce/all`

Announce to all available devices:

```bash
curl -s -X POST "$BASE_URL/api/announce/all" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Hello everyone",
    "title": "Echo Whispers"
  }'
```

Common announcement parameters:

| Parameter | Description |
|---|---|
| `text` | Announcement message |
| `devices` | Comma-separated device serial numbers for GET; array of device objects for POST |
| `title` | Optional announcement title |
| `all=true` | Select all available announcement-capable devices |

If an API key is enabled, include it in the header:

```bash
curl -G "$BASE_URL/api/announce/all" \
  -H "x-api-key: $API_KEY" \
  --data-urlencode "text=Hello everyone"
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

Returns Hubitat integration status:

```bash
curl -s "$BASE_URL/api/hubitat/status" -H "x-api-key: $API_KEY"
```

### `POST /api/hubitat/config`

Configures Hubitat compatibility:

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

Sends server info to Hubitat:

```bash
curl -s -X POST "$BASE_URL/api/hubitat/send-server-data" -H "x-api-key: $API_KEY"
```

### `POST /api/hubitat/send-cookie`

Sends the current Amazon cookie to Hubitat:

```bash
curl -s -X POST "$BASE_URL/api/hubitat/send-cookie" -H "x-api-key: $API_KEY"
```

### `POST /api/hubitat/pull-cookie`

Pulls cookie data from Hubitat if supported/configured:

```bash
curl -s -X POST "$BASE_URL/api/hubitat/pull-cookie" -H "x-api-key: $API_KEY"
```

### `DELETE /api/hubitat/cookie`

Clears the Hubitat-side cookie through the configured callback flow:

```bash
curl -s -X DELETE "$BASE_URL/api/hubitat/cookie" -H "x-api-key: $API_KEY"
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

Clickable GET examples can also include:

```text
?apiKey=YOUR_API_KEY
```

### Cannot clear API Key

Leave the API Key field blank and click `Save Settings`.

The UI will authorize that save using the prior key.

### Devices do not load

Check status:

```bash
curl -s "$BASE_URL/api/status" -H "x-api-key: $API_KEY"
```

Refresh the cookie:

```bash
curl -s -X POST "$BASE_URL/api/auth/refresh-cookie" -H "x-api-key: $API_KEY"
```

If needed, perform Amazon Login again from the UI.

### HTTP 429: Too Many Requests

Amazon may rate-limit repeated Alexa commands. Avoid sending many Speak requests in rapid succession. For the same message to multiple devices, use Announce to send one request instead.

### View PM2 logs

```bash
pm2 logs echo-whispers
```

---

## Development

Run locally:

```bash
npm install
node server.js
```

Check syntax and dependencies:

```bash
node --check server.js
npm audit
```

Common Git update flow:

```bash
git status
git add README.md
git commit -m "Update README"
git push
```

---

## License

This project is released under the MIT License.

You are free to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of this software, provided the copyright notice and license text are included.

See [`LICENSE`](LICENSE) for the full license text.


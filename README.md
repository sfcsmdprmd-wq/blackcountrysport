# SignalFlow Encoder

This service follows the SignalFlow playout schedule and maintains one continuous MP3 or AAC source connection to an Icecast-compatible server. It plays silence when the schedule is empty, switches automatically between scheduled items, seeks into late-joined audio files, and fades a back-timed stream during its final three seconds.

## Requirements

- An Ubuntu 24.04 server with at least 1 GB RAM
- Docker Engine and the Docker Compose plugin
- Your Icecast source hostname, port, username, password and mount point
- The SignalFlow Site access token while the Site remains private

## 1. Copy the package to the Droplet

From a terminal on your computer, with this folder as the current directory:

```bash
scp -r . signalflow@YOUR_DROPLET_IP:/tmp/signalflow-encoder
```

Then connect to the server:

```bash
ssh signalflow@YOUR_DROPLET_IP
```

Install the package:

```bash
sudo mkdir -p /opt/signalflow-encoder
sudo cp -R /tmp/signalflow-encoder/. /opt/signalflow-encoder/
sudo chown -R signalflow:signalflow /opt/signalflow-encoder
cd /opt/signalflow-encoder
cp .env.example .env
chmod 600 .env
```

## 2. Add the connection settings

Open the protected configuration file:

```bash
nano .env
```

Set the Icecast values supplied by your streaming host. Do not add spaces around `=` and do not put the source password in source control.

For the broadest radio-directory and hardware-player support, retain:

```dotenv
AUDIO_FORMAT=mp3
AUDIO_BITRATE=128k
AUDIO_SAMPLE_RATE=44100
AUDIO_CHANNELS=2
ICECAST_MOUNT=/signalflow.mp3
```

If the Icecast source port uses TLS, set `ICECAST_TLS=true`. `ICECAST_PUBLIC=true` controls Icecast's own directory-public flag; it does not submit the station to third-party directories.

The current SignalFlow Site is private. Put its private machine-access token in `SIGNALFLOW_SITE_TOKEN`. This is separate from the Icecast password and must also be treated as secret. Leave it empty only if the Site is later made public.

Save in nano with **Ctrl+O**, **Enter**, then **Ctrl+X**.

## 3. Build and start

```bash
docker compose build
docker compose up -d
```

The `restart: unless-stopped` policy starts the encoder again after a Droplet reboot or process failure.

## 4. Check operation

```bash
docker compose ps
docker compose logs --tail=100 -f
```

You should see `Connecting continuous output to Icecast`, followed by scheduled item changes. Stop following logs with **Ctrl+C**; this does not stop the encoder.

Test the mount in VLC or a browser:

```text
http://ICECAST_HOST:ICECAST_PORT/signalflow.mp3
```

Use `https://` if your listening endpoint is secured by TLS or a reverse proxy.

## Useful commands

```bash
# Restart after changing .env
docker compose up -d --force-recreate

# View recent logs
docker compose logs --tail=200

# Stop the encoder
docker compose down

# Rebuild after replacing package files
docker compose build --pull
docker compose up -d
```

## Firewall

The encoder initiates outbound connections to SignalFlow and Icecast, so it does not require an inbound public application port. Keep inbound access restricted to SSH. If the Icecast host restricts source connections by IP address, allowlist the Droplet's public IPv4 address.

## Troubleshooting

- **HTTP 401/403 from SignalFlow:** the Site token is missing, invalid or expired.
- **Icecast 401:** check source username and source password. The source password is different from the Icecast administration password.
- **Connection refused:** verify hostname, source port and TLS setting, and ask the Icecast provider whether the Droplet IP must be allowlisted.
- **Mount already in use:** disconnect another encoder using the same mount or select a different mount.
- **No audio but connected:** check that an item is currently scheduled; silence is deliberately transmitted between items.

## Security

Keep `.env` readable only by the deployment user (`chmod 600 .env`). Use SSH keys, keep Ubuntu and Docker updated, and never paste either password or token into support messages or commit them to Git.

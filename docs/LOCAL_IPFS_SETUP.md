# Local IPFS Node Setup for Testing

This guide helps you set up a local IPFS node on your machine to test SPK Network 2.0 integration.

## What SPK Network Uses

From analyzing the original SPK Network's `trole` repository:

### Key Components
- **Kubo (go-ipfs)**: The standard IPFS implementation
- **HTTP API**: Communicates via port 5001 for adding/pinning content
- **Gateway**: Port 8080 for read-only content retrieval
- **Swarm**: Port 4001 for peer-to-peer connections

### Key Patterns
1. **Chunked uploads** with resumable transfers
2. **CID verification** after each upload
3. **Automatic pinning** to persist content
4. **Queue-based processing** for multiple uploads

---

## Quick Setup (5 minutes)

### Step 1: Install Kubo

**macOS:**
```bash
brew install ipfs
```

**Linux:**
```bash
wget https://dist.ipfs.tech/kubo/v0.27.0/kubo_v0.27.0_linux-amd64.tar.gz
tar -xvzf kubo_v0.27.0_linux-amd64.tar.gz
cd kubo
sudo bash install.sh
```

**Windows:**
```powershell
scoop bucket add extras
scoop install kubo
```

### Step 2: Initialize Your Node

```bash
# Standard initialization
ipfs init

# Or for server/testing (disables local network discovery)
ipfs init --profile server
```

### Step 3: Start the Daemon

```bash
ipfs daemon
```

Expected output:
```
Initializing daemon...
API server listening on /ip4/127.0.0.1/tcp/5001
WebUI: http://127.0.0.1:5001/webui
Gateway server listening on /ip4/127.0.0.1/tcp/8080
Daemon is ready
```

### Step 4: Test Your Node

```bash
# Add a test file
echo "Hello SPK Network!" > test.txt
ipfs add test.txt
# Returns: added Qm... test.txt

# Retrieve it
ipfs cat Qm...

# Or via HTTP Gateway
curl http://localhost:8080/ipfs/Qm...
```

---

## Connect to SPK Network 2.0

Set these environment variables to connect your local IPFS node to our app:

```bash
# Local IPFS node
IPFS_API_URL=http://localhost:5001

# For the Gateway (read-only access)
IPFS_GATEWAY_URL=http://localhost:8080
```

---

## Configuration for Testing

### Enable CORS (Required for Web Apps)

```bash
ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '["*"]'
ipfs config --json API.HTTPHeaders.Access-Control-Allow-Methods '["PUT", "POST", "GET"]'
ipfs config --json API.HTTPHeaders.Access-Control-Allow-Headers '["Authorization"]'
```

### Storage Limits

```bash
# Set max storage (default is 10GB)
ipfs config Datastore.StorageMax "20GB"

# Auto garbage collect at 90% capacity
ipfs config Datastore.StorageGCWatermark 90
```

### Offline Mode (No Network)

For isolated testing without connecting to the global IPFS network:

```bash
ipfs daemon --offline
```

---

## Docker Alternative

If you prefer Docker:

```bash
# Create data directories
mkdir -p ~/.ipfs-test/data ~/.ipfs-test/staging

# Run IPFS container
docker run -d --name ipfs-test \
  -v ~/.ipfs-test/data:/data/ipfs \
  -v ~/.ipfs-test/staging:/export \
  -p 4001:4001 \
  -p 4001:4001/udp \
  -p 127.0.0.1:8080:8080 \
  -p 127.0.0.1:5001:5001 \
  ipfs/kubo:v0.27.0

# Test it
docker exec ipfs-test ipfs id
```

---

## API Reference

The IPFS HTTP API endpoints we use:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v0/add` | POST | Add file to IPFS |
| `/api/v0/cat` | POST | Retrieve file content |
| `/api/v0/pin/add` | POST | Pin content (persist) |
| `/api/v0/pin/rm` | POST | Unpin content |
| `/api/v0/pin/ls` | POST | List pinned content |
| `/api/v0/id` | POST | Get node ID |
| `/api/v0/repo/stat` | POST | Repository statistics |

### Example: Add File

```bash
curl -X POST -F file=@myfile.txt http://localhost:5001/api/v0/add
```

Response:
```json
{
  "Name": "myfile.txt",
  "Hash": "QmY7Yh4UquoXH...",
  "Size": "123"
}
```

### Example: Pin Content

```bash
curl -X POST "http://localhost:5001/api/v0/pin/add?arg=QmY7Yh4UquoXH..."
```

---

## Troubleshooting

### Port Already in Use
```bash
# Check what's using the port
lsof -i :5001

# Kill existing IPFS daemon
killall ipfs
```

### Reset Node
```bash
# Backup and reset
mv ~/.ipfs ~/.ipfs.backup
ipfs init
```

### Check Daemon Status
```bash
# If this works, daemon is running
ipfs stats bw
```

---

## Next Steps

Once your local IPFS node is running:

1. Set `IPFS_API_URL=http://localhost:5001` in your environment
2. The app will detect and use your local node for storage operations
3. Test uploads via the Storage page
4. View content via the IPFS Gateway at `http://localhost:8080/ipfs/{CID}`

---

## Resources

- [Kubo GitHub](https://github.com/ipfs/kubo)
- [IPFS HTTP API Docs](https://docs.ipfs.tech/reference/kubo/rpc/)
- [SPK Network Trole](https://github.com/spknetwork/trole)
- [IPFS Config Reference](https://github.com/ipfs/kubo/blob/master/docs/config.md)

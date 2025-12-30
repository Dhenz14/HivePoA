/**
 * Static Build Script
 * Builds only the frontend as static files for PWA hosting
 * Can be hosted on GitHub Pages, IPFS, Netlify, etc.
 */

import { build as viteBuild } from "vite";
import { rm, mkdir, writeFile } from "fs/promises";
import path from "path";

async function buildStatic() {
  const outDir = "dist-static";
  
  await rm(outDir, { recursive: true, force: true });
  
  console.log("Building static PWA...");
  
  await viteBuild({
    build: {
      outDir: path.resolve(process.cwd(), outDir),
      emptyOutDir: true,
    },
  });
  
  // Create a simple 404.html for SPA routing on GitHub Pages
  const indexHtml = await import("fs").then(fs => 
    fs.readFileSync(path.join(outDir, "index.html"), "utf-8")
  );
  await writeFile(path.join(outDir, "404.html"), indexHtml);
  
  // Create CNAME file placeholder if deploying to custom domain
  await writeFile(path.join(outDir, "CNAME.example"), "# Rename to CNAME and add your domain\n# example: hivepoa.example.com\n");
  
  // Create deployment instructions
  await writeFile(path.join(outDir, "README.md"), `# HivePoA Static Build

This is a static build of HivePoA that can be hosted anywhere.

## Deployment Options

### GitHub Pages
1. Push this folder to a \`gh-pages\` branch
2. Enable GitHub Pages in repository settings
3. Optionally rename \`CNAME.example\` to \`CNAME\` with your domain

### IPFS
1. Run \`ipfs add -r .\` in this directory
2. Pin the resulting CID to keep it available
3. Access via any IPFS gateway

### Netlify/Vercel/Cloudflare Pages
1. Upload this directory as a static site
2. Set build command to: (none - already built)
3. Set publish directory to this folder

## Configuration

When using the app:
1. Go to "Connect Node" in the sidebar
2. Select your connection mode (Local/Remote/Demo)
3. Enter your IPFS node's API URL (e.g., http://192.168.1.100:5001)
4. Test the connection

## Requirements

For full functionality, you need:
- An IPFS node (Kubo) running on your network
- CORS enabled on the IPFS node for your domain
- Port forwarding if accessing remotely

## CORS Configuration

Add this to your IPFS config:

\`\`\`json
{
  "API": {
    "HTTPHeaders": {
      "Access-Control-Allow-Origin": ["*"],
      "Access-Control-Allow-Methods": ["PUT", "POST", "GET"]
    }
  }
}
\`\`\`

Or run:
\`\`\`bash
ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '["*"]'
ipfs config --json API.HTTPHeaders.Access-Control-Allow-Methods '["PUT", "POST", "GET"]'
\`\`\`
`);

  console.log(`\nStatic build complete! Output: ${outDir}/`);
  console.log("You can now deploy this folder to any static hosting service.");
}

buildStatic().catch((err) => {
  console.error(err);
  process.exit(1);
});

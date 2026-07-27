#!/usr/bin/env node
/**
 * Wave Compute MCP — 1-Click Cursor Installer
 * Run: npx wave-mcp-setup
 * 
 * Auto-detects Cursor config location, adds the wave-compute MCP server,
 * and writes it back. All you need is your Wave OS API token.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';
import { createInterface } from 'readline';

const WAVE_MCP_URL = 'https://oswave.io/api/functions/mcpRouter';

// Cursor config paths per platform
function getCursorConfigPath() {
  const home = homedir();
  const p = platform();
  if (p === 'win32') return join(home, '.cursor', 'mcp.json');
  if (p === 'darwin') return join(home, '.cursor', 'mcp.json');
  return join(home, '.cursor', 'mcp.json');
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

async function main() {
  console.log('\n  ⚡ Wave Compute MCP — Cursor Installer\n');
  console.log('  ─────────────────────────────────────────\n');
  console.log('  This will add the Wave Compute MCP server to your Cursor config.\n');
  console.log('  You need your Wave OS API token from: oswave.io → Settings → Developer\n');

  // Get token
  let token = process.argv[2];
  if (!token) {
    token = await ask('  Paste your Wave API token: ');
  }

  if (!token) {
    console.log('\n  ❌ No token provided. Get one at oswave.io → Settings → Developer');
    process.exit(1);
  }

  // Normalize token
  if (token.startsWith('Bearer ')) token = token.slice(7);
  token = token.trim();

  // Find Cursor config
  const configPath = getCursorConfigPath();
  const configDir = join(configPath, '..');

  console.log(`\n  📁 Cursor config: ${configPath}`);

  // Read existing config or create new
  let config = { mcpServers: {} };
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (!config.mcpServers) config.mcpServers = {};
    } catch {
      console.log('  ⚠️  Existing config is invalid JSON, starting fresh.');
    }
  } else {
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  }

  // Check if already exists
  if (config.mcpServers['wave-compute']) {
    const overwrite = await ask('\n  wave-compute already exists. Overwrite? (y/n): ');
    if (overwrite.toLowerCase() !== 'y') {
      console.log('\n  ⏭️  Skipped. Existing config unchanged.');
      process.exit(0);
    }
  }

  // Add wave-compute MCP server
  config.mcpServers['wave-compute'] = {
    url: WAVE_MCP_URL,
    type: 'http',
    headers: {
      Authorization: `Bearer ${token}`
    }
  };

  // Write config
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  console.log('\n  ✅ Wave Compute MCP added to Cursor!\n');
  console.log('  ─────────────────────────────────────────\n');
  console.log('  Next steps:\n');
  console.log('  1. Open Cursor (or reload: Ctrl+Shift+P → "Developer: Reload Window")');
  console.log('  2. Check the MCP panel — you should see a green dot next to wave-compute');
  console.log('  3. 28 tools are now available in AI chat\n');
  console.log('  Get your API token anytime at: oswave.io → Settings → Developer\n');
}

main().catch(e => {
  console.error('\n  ❌ Error:', e.message);
  process.exit(1);
});

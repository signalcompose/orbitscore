#!/usr/bin/env node
const path = require('node:path');
const fs = require('node:fs');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

async function main() {
  const text = process.argv.slice(2).join(' ') || 'Hello';
  const channel = process.env.ORBITSCORE_SLACK_CHANNEL || process.env.SLACK_CHANNEL || '#_yamato_notify';
  const mcpBase = process.env.ORBITSCORE_MCP_BASE_URL;
  const mcpToken = process.env.ORBITSCORE_MCP_TOKEN;

  if (mcpBase) {
    const headers = { 'content-type': 'application/json' };
    if (mcpToken) headers['authorization'] = `Bearer ${mcpToken}`;
    const res = await fetch(`${mcpBase.replace(/\/$/, '')}/notify`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text, channel })
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      console.error('MCP notify failed:', msg);
      process.exit(1);
    }
    console.log('Sent MCP notify to', channel || '(default)');
    return;
  }

  const token = process.env.ORBITSCORE_SLACK_BOT_TOKEN || process.env.SLACK_BOT_TOKEN;
  if (!token || !channel) {
    console.error('Missing ORBITSCORE_SLACK_BOT_TOKEN or ORBITSCORE_SLACK_CHANNEL in .env');
    process.exit(1);
  }
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ channel, text })
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) {
    console.error('Slack API error:', json.error || res.statusText);
    process.exit(1);
  }
  console.log('Sent Slack message to', channel);
}

main().catch(err => { console.error(err); process.exit(1); });

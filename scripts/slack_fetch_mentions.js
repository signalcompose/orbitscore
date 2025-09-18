#!/usr/bin/env node
const path = require('node:path')
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') })

const token = process.env.ORBITSCORE_SLACK_BOT_TOKEN || process.env.SLACK_BOT_TOKEN
const channelPref = (process.env.ORBITSCORE_SLACK_CHANNEL || process.env.SLACK_CHANNEL || '').trim()

if (!token) {
  console.error('Missing ORBITSCORE_SLACK_BOT_TOKEN (or SLACK_BOT_TOKEN) in .env')
  process.exit(1)
}

async function slackApi(pathname, body) {
  const url = `https://slack.com/api/${pathname}`
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    authorization: `Bearer ${token}`,
  }
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const json = await res.json()
  if (!json.ok) throw new Error(`${pathname} error: ${json.error}`)
  return json
}

async function resolveChannelId(input) {
  if (!input) return null
  const name = input.startsWith('#') ? input.slice(1) : input
  if (/^C[A-Z0-9]+$/i.test(name)) return name
  const list = await slackApi('conversations.list', {
    limit: 200,
    exclude_archived: true,
    types: 'public_channel,private_channel',
  })
  const ch = (list.channels || []).find((c) => c.name === name)
  return ch ? ch.id : null
}

async function getBotUserId() {
  const auth = await slackApi('auth.test', {})
  return auth.user_id // e.g., U0123...
}

async function main() {
  const channelId = await resolveChannelId(channelPref)
  const channel = channelId || channelPref
  const botUserId = await getBotUserId()

  const hist = await slackApi('conversations.history', {
    channel,
    limit: 100,
    include_all_metadata: true,
  })
  const mentionTag = `<@${botUserId}>`
  const mentions = (hist.messages || [])
    .filter((m) => typeof m.text === 'string' && m.text.includes(mentionTag))
    .map((m) => ({ ts: m.ts, user: m.user, text: m.text }))

  console.log(
    JSON.stringify(
      {
        channel,
        botUserId,
        count: mentions.length,
        mentions: mentions.reverse(),
      },
      null,
      2,
    ),
  )
}

main().catch((err) => {
  console.error(String(err))
  process.exit(1)
})

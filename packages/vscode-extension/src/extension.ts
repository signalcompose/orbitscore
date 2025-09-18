import * as vscode from 'vscode';
import * as path from 'node:path';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as dotenv from 'dotenv';

let pollingTimer: NodeJS.Timeout | null = null;
const LAST_TS_KEY = 'orbitscore.lastMentionTs';

function findRepoRoot(startDir: string | undefined, context?: vscode.ExtensionContext): string | undefined {
  let dir = startDir;
  if (!dir && context) {
    // ワークスペースが無い場合は拡張の配置場所から上に上がってリポジトリ直下を推定
    dir = path.resolve(context.extensionUri.fsPath, '..', '..');
  }
  for (let i = 0; i < 6 && dir; i++) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        const json = JSON.parse(fs.readFileSync(pkg, 'utf8'));
        if (json?.scripts?.['slack:mentions']) return dir; // ルート判定
      } catch {}
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir ?? undefined;
}

function loadEnv(context: vscode.ExtensionContext) {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const repoRoot = findRepoRoot(ws, context);
  if (repoRoot) {
    const envPath = path.join(repoRoot, '.env');
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath });
      return;
    }
  }
  dotenv.config();
}

async function pollSlackMentions(context: vscode.ExtensionContext) {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const folder = findRepoRoot(ws, context);
  if (!folder) return; // ルート未特定ならスキップ
  const script = path.join(folder, 'scripts', 'slack_fetch_mentions.js');
  const nodeBin = process.execPath; // VS CodeのNode実行ファイル
  if (!fs.existsSync(script)) {
    vscode.window.setStatusBarMessage('Slack polling script not found.', 5000);
    return;
  }
  cp.execFile(nodeBin, [script], { cwd: folder }, (err, stdout, stderr) => {
    if (err) {
      console.error('slack:mentions error', err, stderr);
      vscode.window.setStatusBarMessage('Slack polling error. See console.', 5000);
      return;
    }
    try {
      const json = JSON.parse(stdout.trim().split('\n').slice(-1)[0]!);
      const items = json.mentions as Array<{ ts: string; user: string; text: string }>;
      if (!items || items.length === 0) return;
      const last = items[items.length - 1]!;
      const prevTs = context.globalState.get<string>(LAST_TS_KEY);
      if (!prevTs || last.ts > prevTs) {
        context.globalState.update(LAST_TS_KEY, last.ts);
        vscode.window.setStatusBarMessage(`Slack mention: ${last.text}`, 5000);
        vscode.window.showInformationMessage(`Slack mention: ${last.text}`);
      }
    } catch (e) {
      // ignore parse errors (stdout may include logs)
    }
  });
}

export function activate(context: vscode.ExtensionContext) {
  loadEnv(context);
  // 起動後に定期ポーリング開始（10秒間隔に短縮）
  pollingTimer = setInterval(() => pollSlackMentions(context), 10000);
  // すぐ一回実行
  pollSlackMentions(context);
}

export function deactivate() {
  if (pollingTimer) clearInterval(pollingTimer);
}

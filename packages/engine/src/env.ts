import * as path from 'node:path';
import * as fs from 'node:fs';
import dotenv from 'dotenv';

/**
 * プロジェクトの .env を読み込む（ルート or パッケージ配下）
 * 優先度: CWD/.env → リポジトリルート/.env → engine/.env → デフォルト
 */
export function loadProjectEnv(): string | undefined {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(__dirname, '../../../.env'), // repo root when running from dist
    path.resolve(__dirname, '../../.env'),    // engine package root
  ];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        dotenv.config({ path: p });
        return p;
      }
    } catch {
      // ignore
    }
  }

  dotenv.config();
  return undefined;
}

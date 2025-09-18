import { createNotifierFromEnv } from "./notifier";
import { loadProjectEnv } from "./env";

async function main() {
  loadProjectEnv();
  const notifier = createNotifierFromEnv();
  if (!notifier) {
    console.error(
      "Notifier not configured. Set ORBITSCORE_MCP_BASE_URL in .env",
    );
    process.exit(1);
  }
  const text = process.argv.slice(2).join(" ") || "Hello";
  await notifier.notify(text, { from: "orbitscore-engine" });
  console.log("Sent Slack MCP notify:", text);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

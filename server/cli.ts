#!/usr/bin/env node
// User management: node server/cli.ts <command>
//   add <username>       create a user (prompts for a password, or reads LIFE_DASH_PASSWORD)
//   passwd <username>    change a password and sign out that user's sessions
//   list                 list users
//   remove <username>    delete a user and all of their data
import { createInterface } from "node:readline";
import { loadConfig } from "./config.ts";
import { type UserRow, openDb, now, one, all, run } from "./db.ts";
import { hashPassword, passwordProblem, USERNAME_RE } from "./crypto.ts";

const [cmd, name] = process.argv.slice(2);
const db = openDb(loadConfig().dbPath);

function askHidden(prompt: string): Promise<string> {
  if (process.env.LIFE_DASH_PASSWORD) return Promise.resolve(process.env.LIFE_DASH_PASSWORD);
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // hide typed characters: only echo the prompt itself
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = s => { if (s.includes(prompt)) process.stdout.write(s); };
    rl.question(prompt, a => { rl.close(); process.stdout.write("\n"); resolve(a); });
  });
}
async function newPassword(): Promise<string> {
  const p1 = await askHidden("Password: ");
  const problem = passwordProblem(p1);
  if (problem) { console.error(problem); process.exit(1); }
  if (!process.env.LIFE_DASH_PASSWORD && p1 !== await askHidden("Repeat password: ")) { console.error("Passwords don't match."); process.exit(1); }
  return hashPassword(p1);
}
const need = (): string => { if (!name) { console.error(`Usage: node server/cli.ts ${cmd} <username>`); process.exit(1); } return name; };
const find = (): { id: number } => one<{ id: number }>(db, "SELECT id FROM users WHERE username = ?", need()) ?? (console.error(`No user named ${name}.`), process.exit(1));

if (cmd === "add") {
  const username = need();
  if (!USERNAME_RE.test(username)) { console.error("Use a username of up to 64 letters, numbers, dots, dashes, underscores or @."); process.exit(1); }
  if (one(db, "SELECT 1 FROM users WHERE username = ?", username)) { console.error(`${username} already exists.`); process.exit(1); }
  run(db, "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)", username, await newPassword(), now());
  console.log(`Created ${username}.`);
} else if (cmd === "passwd") {
  const u = find();
  run(db, "UPDATE users SET password_hash = ? WHERE id = ?", await newPassword(), u.id);
  run(db, "DELETE FROM sessions WHERE user_id = ?", u.id);
  console.log(`Password changed for ${name}; existing sessions signed out.`);
} else if (cmd === "list") {
  for (const u of all<Pick<UserRow, "username" | "created_at">>(db, "SELECT username, created_at FROM users ORDER BY id")) {
    console.log(`${u.username}\tcreated ${new Date(u.created_at * 1000).toISOString().slice(0, 10)}`);
  }
} else if (cmd === "remove") {
  const u = find();
  run(db, "DELETE FROM users WHERE id = ?", u.id);
  console.log(`Removed ${name} and their data.`);
} else {
  console.log("Usage: node server/cli.ts add|passwd|remove <username> | list");
  process.exit(cmd ? 1 : 0);
}
db.close();

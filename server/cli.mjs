#!/usr/bin/env node
// User management: node server/cli.mjs <command>
//   add <username>       create a user (prompts for a password, or reads LIFE_DASH_PASSWORD)
//   passwd <username>    change a password and sign out that user's sessions
//   list                 list users
//   remove <username>    delete a user and all of their data
import { createInterface } from "node:readline";
import { loadConfig } from "./config.mjs";
import { openDb, now } from "./db.mjs";
import { hashPassword, passwordProblem, USERNAME_RE } from "./crypto.mjs";

const [cmd, name] = process.argv.slice(2);
const db = openDb(loadConfig().dbPath);

function askHidden(prompt) {
  if (process.env.LIFE_DASH_PASSWORD) return Promise.resolve(process.env.LIFE_DASH_PASSWORD);
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = s => { if (s.includes(prompt)) process.stdout.write(s); };
    rl.question(prompt, a => { rl.close(); process.stdout.write("\n"); resolve(a); });
  });
}
async function newPassword() {
  const p1 = await askHidden("Password: ");
  const problem = passwordProblem(p1);
  if (problem) { console.error(problem); process.exit(1); }
  if (!process.env.LIFE_DASH_PASSWORD && p1 !== await askHidden("Repeat password: ")) { console.error("Passwords don't match."); process.exit(1); }
  return hashPassword(p1);
}
const need = () => { if (!name) { console.error(`Usage: node server/cli.mjs ${cmd} <username>`); process.exit(1); } };
const find = () => db.prepare("SELECT id FROM users WHERE username = ?").get(name) || (console.error(`No user named ${name}.`), process.exit(1));

if (cmd === "add") {
  need();
  if (!USERNAME_RE.test(name)) { console.error("Use a username of up to 64 letters, numbers, dots, dashes, underscores or @."); process.exit(1); }
  if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(name)) { console.error(`${name} already exists.`); process.exit(1); }
  db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)").run(name, await newPassword(), now());
  console.log(`Created ${name}.`);
} else if (cmd === "passwd") {
  need(); const u = find();
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await newPassword(), u.id);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(u.id);
  console.log(`Password changed for ${name}; existing sessions signed out.`);
} else if (cmd === "list") {
  for (const u of db.prepare("SELECT username, created_at FROM users ORDER BY id").all()) console.log(`${u.username}\tcreated ${new Date(u.created_at * 1000).toISOString().slice(0, 10)}`);
} else if (cmd === "remove") {
  need(); const u = find();
  db.prepare("DELETE FROM users WHERE id = ?").run(u.id);
  console.log(`Removed ${name} and their data.`);
} else {
  console.log("Usage: node server/cli.mjs add|passwd|remove <username> | list");
  process.exit(cmd ? 1 : 0);
}
db.close();

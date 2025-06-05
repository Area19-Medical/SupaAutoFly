#!/bin/env -S npx tsx

import { prompt } from "enquirer";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

async function main() {
  // Prompt for password twice and compare
  const { password } = await prompt<{ password: string }>([
    {
      type: "password",
      name: "password",
      message: "Enter new Postgres password:",
      validate: (val: string) =>
        val.length < 16
          ? "Password must be at least 16 characters long"
          : !val.includes("/") || "Password cannot contain '/' character",
    },
  ]);
  if (password.includes("/")) {
    console.error("Password cannot contain '/' character. Aborting.");
    process.exit(1);
  }
  const { password2 } = await prompt<{ password2: string }>([
    {
      type: "password",
      name: "password2",
      message: "Re-enter new Postgres password:",
      validate: (val: string) => val.length > 0 || "Password cannot be empty",
    },
  ]);
  if (password !== password2) {
    console.error("Passwords do not match. Aborting.");
    process.exit(1);
  }

  // Prepare SQL commands
  const sql = [
    `ALTER USER supabase_admin WITH PASSWORD '${password}';`,
    `ALTER USER postgres WITH PASSWORD '${password}';`,
    `ALTER USER authenticator WITH PASSWORD '${password}';`,
    `ALTER USER pgbouncer WITH PASSWORD '${password}';`,
    `ALTER USER supabase_auth_admin WITH PASSWORD '${password}';`,
    `ALTER USER supabase_functions_admin WITH PASSWORD '${password}';`,
    `ALTER USER supabase_storage_admin WITH PASSWORD '${password}';`,
    `\\q`,
  ].join("\n");

  // Run fly ssh console and execute SQL
  const proc = spawnSync(
    "fly",
    ["-c", "db/fly.toml", "ssh", "console", "-C", "psql -U supabase_admin"],
    { input: sql, stdio: ["pipe", "inherit", "inherit"] }
  );

  if (proc.status !== 0) {
    console.error("Failed to update passwords in database.");
    process.exit(1);
  }

  // Write password to .env
  const envPath = path.resolve(process.cwd(), ".env");
  let envContent = "";
  let replaced = false;
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("POSTGRES_PASSWORD=")) {
        lines[i] = `POSTGRES_PASSWORD=${password}`;
        replaced = true;
      }
    }
    envContent = lines.filter((line) => line.trim().length > 0).join("\n");
    if (!replaced) {
      envContent += `\nPOSTGRES_PASSWORD=${password}`;
    }
    envContent += "\n";
  } else {
    envContent = `POSTGRES_PASSWORD=${password}\n`;
  }
  fs.writeFileSync(envPath, envContent, { mode: 0o600 });

  console.log("Password updated and saved to .env.");
  console.log(
    "To adjust all dependent services, copy the .env file to the root of SupaAutoFly and run makeFly.ts and fly/deploy-all.sh again."
  );
}

main();

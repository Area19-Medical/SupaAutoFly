# Migration Cheat Sheet
for self-hosted supabase instances

In your project directory, you would typically have a `supabase/migrations` directory where you can manage your database migrations. Here’s a quick guide on how to handle migrations in a self-hosted Supabase instance.

The general idea is that you would use a local `supabase` development instance managed by the `supabase` CLI. It is generally designed to be used with the `supabase.com` hosted service but can also be used with self-hosted instances.

You would locally work on your database schema, then diff it against the recorded migrations to generate new migration files and then apply them to your self-hosted instance.

## Setting up your local environment

1. **Install Supabase CLI**: Make sure you have the Supabase CLI installed. You can find installation instructions in the [Supabase CLI documentation](https://supabase.com/docs/guides/cli). Basically:
   ```shell
   npm install supabase --save-dev
   ```
2. **Initialize Supabase**: If you haven't already, initialize your Supabase project in your local directory:
   ```shell
   npx supabase init
   ```
3. **Start Supabase**: Start your local Supabase instance:
   ```shell
   npx supabase start
   ```

4. **Identify your db-url**: Take a look at your `fly/functions/secrets.ts` file. It contains an entry looking like
   ```shell
   SUPABASE_DB_URL=postgresql://postgres:<yourpassword>@<yourprefix>-db.internal:5432/postgres
   ```
   Replace `.internal` with `.fly.dev` to get the correct URL for your self-hosted instance.

   You can also use `~/.pgpass` to store your database credentials securely, which the Supabase CLI can use to connect to your database.

## Creating migrations

To create a new migration, you can use the following command:

```shell
npx supabase db diff -f <migration_name>
```

This command will generate a new migration file in the `supabase/migrations` directory based on the current state of your local database schema compared to the last recorded migration.

*It is super important to review the generated migration files before applying them to your production database. ***They may e.g. contain unexpected DROP statements.****

More warnings about migrations automatically generated using `diff`:
* `with (security_invoker=on)` is dropped from view definitions, see https://github.com/supabase/cli/issues/792, which can cause grave security issues
* `CREATE DOMAIN` is not supported
* column-level-security policies are not supported
* `search_path` is not tracked on function definitions even though the security advisor demands its use (for good reason)

See [supabase-cli diff issues](https://github.com/supabase/cli/issues?q=is%3Aissue%20state%3Aopen%20diff) for more issues with the `diff` command.

If you changed things in internal schemata like `auth` (e.g. adding triggers), you'll need to pass the `--schema` option to the `diff` command and list the respective schemata.

Alternatively, you can manually create a migration file using
```shell
npx supabase db migration new <migration_name>
```
This will create an empty migration file where you can manually write your SQL commands.

Using Jupyter notebooks with [JupySQL](https://jupysql.ploomber.io/en/latest/integrations/postgres-connect.html) is a good way to develop and document your migrations. You can use the `%%sql` magic command to run SQL commands in your local development instance directly from the notebook, and then export the SQL code to a migration file.

## Testing migrations

Use
```shell
npx supabase db reset
```
to reset your local database and apply all migrations from the `supabase/migrations` directory.

This way you can check that your migrations work as expected before applying them to your production database.

## Local seed data

If you like, you can also add a `supabase/seed.sql` file to seed your database with initial data after the migrations are applied.

You can dump the data from your local database using:
```shell
npx supabase db dump --data-only --local --file supabase/seed.sql
```

Or from the self-hosted instance using:
```shell
npx supabase db dump --data-only --db-url <your_db_url> --file supabase/seed.sql
```

(Dump files by default set `session_replication_role = replica` which suppresses triggers and foreign key checks. So, if you add seeding commands manually, be aware of that.)

## Push migrations to the self-hosted instance

```shell
npx supabase db push --db-url <your_db_url>
```
This command will apply all migrations in the `supabase/migrations` directory that have not yet been applied to your self-hosted instance.

## List local and remote migrations

```shell
npx supabase db migrations list --db-url <your_db_url>
```
This command will list all migrations that have been applied to your local database and your self-hosted instance.

## Recovering from migration mismatches

You can use
```shell
npx supabase migrations repair [--local|--db-url <your_db_url>] --status [applied|reverted] <migration_name>
```
to manually fix-up the migration table. It is also visible in the supabase studio as `supabase_migrations.schema_migrations`.

## Additional Resources

For more information on using the Supabase CLI and managing migrations, refer to the following resources:
- [Supabase CLI](https://supabase.com/docs/guides/cli)
- [Supabase Migrations](https://supabase.com/docs/guides/deployment/database-migrations)
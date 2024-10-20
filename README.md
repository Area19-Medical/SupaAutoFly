# SupaAutoFly

This script automates the self-hosted deployment of the [supabase](https://supabase.com) stack on [Fly.io](https://fly.io). It clones the [supabase repository](https://github.com/supabase/supabase), sets up the necessary configurations, and generates `fly.toml` files for each service defined in the `docker-compose.yml` file.

## Prerequisites

- Node.js and yarn
- Fly.io CLI
- Docker
- Git

## Setup

1. Clone this repository and navigate to the project directory:

```sh
git clone https://github.com/SupaAutoFly/SupaAutoFly
cd SupaAutoFly
```

2. Create a `.env` file with the required environment variables. You can use the `.env.example` file as a reference:

```sh
cp .env.example .env
```

3. Install the necessary dependencies:

```sh
yarn
```

## Usage

1. Run the script:

```sh
./makeFly.ts
```
or `npx tsx makeFly.ts` if your shell cannot process shebangs.

2. The script will generate a `fly` directory containing `fly.toml` files for each service and deployment scripts.

3. To deploy all services, run:

```sh
./fly/deploy-all.sh
```

4. To destroy all services, run:

```sh
./fly/destroy-all.sh
```

## Environment Variables

The following environment variables are required:

- `FLY_ORG`: The Fly.io organization name.
- `FLY_PREFIX`: The prefix for the Fly.io app names.
- `POSTGRES_PASSWORD`: The password for the PostgreSQL service.
- `JWT_SECRET`: The secret for JWT tokens.
- `ANON_KEY`: The anonymous key for the Auth service (automatically created if not provided).
- `SERVICE_ROLE_KEY`: The service role key for the Auth service (automatically created if not provided).
- `POSTGRES_DB`: The database name for PostgreSQL.
- `POSTGRES_PORT`: The port for the PostgreSQL service.
- `KONG_HTTP_PORT`: The port for the Kong HTTP service.
- `PGRST_DB_SCHEMAS`: The database schemas exposed by PostgREST.
- `PGRST_LOG_LEVEL`: The log level for PostgREST.
- `SITE_URL`: Accepted URL for the Auth service.
- `ADDITIONAL_REDIRECT_URLS`: Additional redirect URLs for the Auth service.
- `JWT_EXPIRY`: The expiry time for JWT tokens.
- `DISABLE_SIGNUP`: Disables signups for the Auth service.
- `MAILER_URLPATHS_*`: The URL paths for the mailer service.
- `ENABLE_EMAIL_SIGNUP`: Enables email signups for the Auth service.
- `ENABLE_EMAIL_AUTOCONFIRM`: Enables auto-confirmation for email signups.
- `SMTP_*`: The SMTP configuration for the Auth mailer service.
- `ENABLE_ANONYMOUS_USERS`: Enables anonymous users for the Auth service.
- `ENABLE_PHONE_SIGNUP`: Enables phone signups for the Auth service.
- `ENABLE_PHONE_AUTOCONFIRM`: Enables auto-confirmation for phone signups.
- `STUDIO_DEFAULT_ORGANIZATION`: The default organization for the Studio service.
- `STUDIO_DEFAULT_PROJECT`: The default project for the Studio service.
- `STUDIO_PORT`: Internal port for the Studio service.
- `IMGPROXY_ENABLE_WEBP_DETECTION`: Enables WebP detection for the imgproxy service.
- `FUNCTIONS_VERIFY_JWT`: Verifies JWT tokens for the Functions service.
- `MINIO_ROOT_USER`: The root user for Minio.
- `MINIO_ROOT_PASSWORD`: The root password for Minio.
- `STORAGE_AWS_ACCESS_KEY_ID`: The access key ID for storage.
- `STORAGE_AWS_SECRET_ACCESS_KEY`: The secret access key for storage.
- `LOGFLARE_API_KEY`: The API key for Logflare.
- `LOGFLARE_LOGGER_BACKEND_API_KEY`: The backend API key for Logflare.
- `GOOGLE_PROJECT_ID`: The project ID for Google BigQuery.
- `GOOGLE_PROJECT_NUMBER`: The project number for Google BigQuery.
- `FLY_LOG_SHIPPER_ACCESS_KEY`: The access key for Fly Log Shipper (automatically created if not provided).

## Customization

You can customize the deployment by modifying the `makeMetadata` function and the `extraServices` object in the `makeFly.ts` script.

Because, this is focussed on deploying Supabase, the script is not designed to be a generic docker-compose to Fly.io converted. Docker-compose is way too rich to make this feasible.

## Limitations

- The script currently does not convert health checks from the `docker-compose.yml` file.
- The dependency resolution is simplistic.

## License

This project is licensed under the MIT License.
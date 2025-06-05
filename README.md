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

## Configuration

The supabase deployment is configured by environment variables in a `.env` file.
Please see the [`.env.example`](.env.example) file for reference.

_Make sure to set up secure secrets._

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

## Deploying Edge Functions

The edge functions to deploy are configured by the `FUNCTIONS_DIR` variable and deployed along with the app initially.

To deploy updated edge functions, you can either destroy the functions app and deploy it anew, or use the `deployFunctions.ts` script to deploy only the edge functions without redeploying the entire app:

1. Make sure, the edge function server is deployed and running, e.g. by running the `deploy-all.sh` script.
2. Navigate to the generated app directory for the edge function server, typically `fly/functions`.
3. Run:
```sh
npx tsx deployFunctions.ts
```

The script will connect to the Fly.io app for the edge functions, upload the new function definitions to the app's volume and set up the necessary secrets from the `.env` file in the specified directory.

You can also point the script to a different functions directory (e.g. `volumes/functions` to redeploy the originally deployed functions) by passing the functions-dir as an argument:

```sh
npx tsx deployFunctions.ts <my-functions-dir>
```

## Customization

You can customize the deployment by modifying the `makeMetadata` function and the `extraServices` object in the `makeFly.ts` script.

Because, this is focussed on deploying Supabase, the script is not designed to be a generic docker-compose to Fly.io converted. Docker-compose is way too rich to make this feasible.

## Limitations

- The script currently does not convert health checks from the `docker-compose.yml` file.
- The dependency resolution is simplistic.
- Edge functions currently do not support the [`config.toml`](https://supabase.com/docs/guides/functions/development-tips#using-configtoml) file. There is just a global `VERIFY_JWT` variable for all functions.

## License

This project is licensed under the MIT License.
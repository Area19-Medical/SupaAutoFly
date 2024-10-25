#!/bin/env -S npx tsx

import { parse } from "yaml";
import * as fs from "node:fs";
import { stringify } from "smol-toml";
import "dotenv/config";
import { splitShellString } from "./splitShellString";
import * as path from "path";
import { execSync } from 'node:child_process';
import { replaceInFileSync } from "replace-in-file";
import dedent from "ts-dedent";
import { solve as solveDependencies } from "dependency-solver";
import { sign, verify } from "jsonwebtoken";
import { deepmerge } from "deepmerge-ts";

const baseRepo = "https://github.com/supabase/supabase.git";
const baseBranch = "da4e05d8fa54c0dade2925f33c62b7f3ce4f36d6";

const org = process.env.FLY_ORG || "personal";

const defaultVm = {
    memory: "1GB"
};

const dockerDir = "./supabase/docker/";

type Context = {
    prefix: string;
    name: string;
    composeData: any;
    dir: string;
    metadata: any;
};

type ServiceMetadata = {
    image?: string;
    buildFromRepo?: { repo: string, branch: string, dockerfile?: string };
    ha: boolean;
    env?: { [key: string]: string|number|boolean|undefined };
    secrets?: { [key: string]: true|string };
    suppressPorts?: string[];
    rawPorts?: string[];
    extraPorts?: string[];
    ip?: 'flycast';
    extraVolumes?: string[];
    extraDependsOn?: string[];
    skipVolumes?: string[];
    vm?: any;
    postprocess?: ((context: Context) => void)[];
    preprocess?: ((context: Context) => void)[];
    extraDeployment?: ((context: Context) => string)[];
    extraContainerSetup?: string;
};

type Metadata = {
    [key: string]: ServiceMetadata;
};

function makeMetadata(prefix: string, composeData: any): Metadata {
    // Replace unqualified hostnames in environment variables with
    // internal prefixed hostnames

    function adjustInternalUrls(environment: { [key: string]: string }): { [key: string]: string } {
        return Object.fromEntries(
            Object.entries<string>(environment)
            .map(([key, value]) => {
                try {
                    const url = new URL(value);
                    const origName = url.hostname;
                    url.hostname = origName.replace(/^([^.]+)$/, `${prefix}-$1.internal`);
                    if (url.hostname === origName)
                        return [];
                    return [key, url.toString()];
                } catch (error) {
                    return [];
                }
            })
            .filter((entry) => entry.length > 0)
        );
    }

    function processService(serviceMeta: any) {
        const adjustedUrlEnv = adjustInternalUrls(serviceMeta.environment ?? {});
        if (Object.keys(adjustedUrlEnv).length == 0) return {}
        return { env: adjustedUrlEnv };
    }

    const mappedMetadata = Object.fromEntries(Object.entries<any>(composeData.services)
        .map(([service, serviceCompose]) => [service, processService(serviceCompose)])
        .filter(([_, serviceMeta]) => Object.keys(serviceMeta).length)
    );

    return deepmerge(mappedMetadata, {
        db: {
            ha: false,
            rawPorts: [ "${POSTGRES_PORT}" ],
            secrets: {
                PGPASSWORD: true,
                POSTGRES_PASSWORD: true,
                JWT_SECRET: true,
            }
        },
        auth: {
            ha: true,
            secrets: {
                GOTRUE_DB_DATABASE_URL: true,
                GOTRUE_JWT_SECRET: true,
                GOTRUE_SMTP_PASS: true,
            }
        },
        kong: {
            ha: true,
            suppressPorts : [ "${KONG_HTTPS_PORT}" ],
            env : {
                KONG_DNS_ORDER: "LAST,AAAA,A,CNAME",
            },
            secrets: {
                SUPABASE_ANON_KEY: true,
                SUPABASE_SERVICE_KEY: true,
                DASHBOARD_PASSWORD: true,
            },
            postprocess: [
                postprocessKongYml,
            ],
        },
        meta: {
            ha: true,
            env: {
                PG_META_HOST: "fly-local-6pn"
            },
            secrets: {
                PG_META_DB_PASSWORD: true,
            }
        },
        studio: {
            ha: true,
            env: {
                HOSTNAME: 'fly-local-6pn',
                NEXT_PUBLIC_SITE_URL: `https://${prefix}-kong.fly.dev`,
                NEXT_PUBLIC_GOTRUE_URL: `https://${prefix}-kong.fly.dev/auth/v1`
            },
            secrets: {
                POSTGRES_PASSWORD: true,
                AUTH_JWT_SECRET: true,
                SUPABASE_ANON_KEY: true,
                SUPABASE_SERVICE_KEY: true,
                LOGFLARE_API_KEY: true,
            }
        },
        analytics: {
            ha: false,
            image: "registry.fly.io/supabase-analytics:1.8.11-tv-1",
            buildFromRepo: {
                repo: "https://github.com/tvogel/logflare.git",
                branch: "v1.8.11-tv-1",
            },
            env: {
                LOGFLARE_NODE_HOST: `${prefix}-analytics.fly.dev`,
                LOGFLARE_API_KEY: undefined,
                LOGFLARE_LOG_LEVEL: "warn",
                PHX_HTTP_IP: "::",
                PHX_URL_HOST: `${prefix}-analytics.fly.dev`
            },
            secrets: {
                DB_PASSWORD: true,
                POSTGRES_BACKEND_URL: true,
                LOGFLARE_PUBLIC_ACCESS_TOKEN: '${LOGFLARE_API_KEY}',
            }
        },
        rest: {
            ha: true,
            env: {
                PGRST_SERVER_HOST: "fly-local-6pn",
                PGRST_LOG_LEVEL: "${PGRST_LOG_LEVEL}",
            },
            secrets: {
                PGRST_JWT_SECRET: true,
                PGRST_APP_SETTINGS_JWT_SECRET: true,
                PGRST_DB_URI: true,
            },
        },
        storage: {
            ha: false,
            env: {
                SERVER_HOST: "fly-local-6pn",
                STORAGE_BACKEND: "s3",
                STORAGE_S3_BUCKET: `${prefix}-storage`,
                STORAGE_S3_MAX_SOCKETS: 200,
                STORAGE_S3_ENDPOINT: `http://${prefix}-minio.internal:9000`,
                STORAGE_S3_FORCE_PATH_STYLE: true,
                // STORAGE_S3_REGION: 'us-east-1',
                FILE_STORAGE_BACKEND_PATH: undefined,
            },
            secrets: {
                ANON_KEY: true,
                SERVICE_KEY: true,
                PGRST_JWT_SECRET: true,
                DATABASE_URL: true,
                AWS_ACCESS_KEY_ID: '${STORAGE_AWS_ACCESS_KEY_ID}',
                AWS_SECRET_ACCESS_KEY: '${STORAGE_AWS_SECRET_ACCESS_KEY}',
            },
            skipVolumes: [ './volumes/storage' ],
            extraDependsOn: [ 'minio' ],
        },
        imgproxy: {
            ha: true,
            env: {
                IMGPROXY_BIND: "fly-local-6pn:5001",
                IMGPROXY_LOCAL_FILESYSTEM_ROOT: undefined,
                IMGPROXY_USE_S3: true,
                IMGPROXY_S3_ENDPOINT: `http://${prefix}-minio.internal:9000`,
            },
            secrets: {
                AWS_ACCESS_KEY_ID: '${STORAGE_AWS_ACCESS_KEY_ID}',
                AWS_SECRET_ACCESS_KEY: '${STORAGE_AWS_SECRET_ACCESS_KEY}',
            },
            skipVolumes: [ './volumes/storage' ],
        },
        realtime: {
            ha: true,
            image: "registry.fly.io/supabase-realtime:2.28.32-tv-1",
            buildFromRepo: {
                repo: "https://github.com/tvogel/realtime.git",
                branch: "v2.28.32-tv-1",
            },
            env: {
                ERL_AFLAGS: "-proto_dist inet6_tcp",
                SEED_SELF_HOST: 0,
            },
            // extraVolumes: [ "./volumes/realtime/runtime.exs:/app/releases/2.28.32/runtime.exs" ],
            secrets: {
                DB_PASSWORD: true,
                DB_ENC_KEY: true,
                API_JWT_SECRET: true,
                SECRET_KEY_BASE: true,
            },
            extraDeployment: [
                makeRealtimeTenantSetup
            ]
        },
        functions: {
            ha: true,
            secrets: {
                JWT_SECRET: true,
                SUPABASE_ANON_KEY: true,
                SUPABASE_SERVICE_ROLE_KEY: true,
                SUPABASE_DB_URL: true,
            },
            extraPorts: [ "9000:9000" ],
            rawPorts: [ "9000" ],
            ip: "flycast"
        },
        minio: {
            ha: false,
            secrets: {
                MINIO_ROOT_PASSWORD: true,
                STORAGE_AWS_ACCESS_KEY_ID: true,
                STORAGE_AWS_SECRET_ACCESS_KEY: true,
            },
            extraContainerSetup: dedent`
                function setup_credentials() {
                    while ! mc alias set local http://localhost:9000 \\\${MINIO_ROOT_USER} \\\${MINIO_ROOT_PASSWORD} &>/dev/null; do
                        sleep 1
                    done
                    echo Succeeded setting up Minio alias >&2
                    mc admin user add local \\\${STORAGE_AWS_ACCESS_KEY_ID} \\\${STORAGE_AWS_SECRET_ACCESS_KEY}
                    mc admin policy attach local readwrite --user \\\${STORAGE_AWS_ACCESS_KEY_ID}
                    mc mb local/${prefix}-storage
                }

                setup_credentials &

                args=("\\\$@")
                if [ "\\\${args[1]}" = "/minio-data" ]; then
                    args[1]="\\\$(realpath /minio-data)"
                fi
                set -- "\\\${args[@]}"\n
                `,
        },
        "fly-log-shipper": {
            ha: false,
            env: {
                SUPABASE_LOGFLARE_URL: `http://${prefix}-analytics.internal:4000/api/logs`,
            },
            secrets: {
                ORG: org,
                ACCESS_TOKEN: '${FLY_LOG_SHIPPER_ACCESS_KEY}',
                SUPABASE_LOGFLARE_API_KEY: '${LOGFLARE_API_KEY}',
            },
            preprocess: [
                makeFlyLogShipperConfig
            ]
        }
    }) as Metadata;
}

const substitutedServices = { vector: "fly-log-shipper" };

const extraServices = {
    minio: {
        container_name: "minio",
        image: "minio/minio",
        environment: {
            MINIO_ROOT_USER: "${MINIO_ROOT_USER}",
            MINIO_ROOT_PASSWORD: "${MINIO_ROOT_PASSWORD}",
            STORAGE_AWS_ACCESS_KEY_ID: "${STORAGE_AWS_ACCESS_KEY_ID}",
            STORAGE_AWS_SECRET_ACCESS_KEY: "${STORAGE_AWS_SECRET_ACCESS_KEY}",
        },
        ports: [ "9001:9001" ],
        volumes: [ "./volumes/minio:/minio-data" ],
        command: ['server', '/minio-data', '--console-address', ':9001'],
    },
    "fly-log-shipper": {
        container_name: "fly-log-shipper",
        image: "flyio/log-shipper:latest",
        volumes: [
            "./volumes/fly-log-shipper/debug.toml:/etc/vector/sinks/debug.toml",
            "./volumes/fly-log-shipper/supabase.toml:/etc/vector/sinks/supabase.toml",
        ],
        environment: {
            SUPABASE_PREFIX: "${FLY_PREFIX}",
        },
        depends_on: {
            // analytics: { condition: "service_healthy" }
        }
    }
}

function expandEnvVars(value: unknown): string {
    const valueString = String(value);
    return valueString.replace(/(^|[^$])\${(.*?)}/g, (_, pre, key) => {
        if (!(key in process.env)) {
            throw new Error(`Environment variable ${key} is not defined`);
        }
        return pre + (process.env[key] || "");
    }).replaceAll('$$', '$');
}

function getDockerUserEntrypointAndCmd(image: string) {
    execSync(`docker pull ${image}`, { stdio: 'inherit' });
    const dockerInspect = JSON.parse(
        execSync(`docker inspect -f json ${image}`,  { encoding: 'utf8' })
    );
    const user = dockerInspect[0].Config.User || 'root';
    const entrypoint = dockerInspect[0].Config.Entrypoint;
    const cmd = dockerInspect[0].Config.Cmd;
    return {user, entrypoint, cmd};
}

function singleQuote(args: string[]): string {
    if (!args || args.length === 0) return "";
    return "'"
    + args.map((arg) => arg.replace(/'/g, "\\'")).join("' '")
    + "'";
}

function doubleQuote(args: string[]): string {
    if (!args || args.length === 0) return "";
    return '"'
    + args.map((arg) => arg.replace(/"/g, '\\"')).join('" "')
    + '"';
}

function makeFly(context: {
    prefix: string;
    name: string;
    composeData: any;
    dir: string;
    metadata: any;
}): string {
    const { prefix, name, composeData, dir, metadata } = context;

    (metadata?.preprocess ?? []).forEach((preprocess: any) => {
        preprocess(context);
    });

    const env = {
        ...Object.fromEntries(
            Object.entries<string>({
                ...composeData.environment,
                ...metadata?.env,
            })
            .filter(([key, _]: [string, string]) => metadata?.secrets?.[key] === undefined)
            .filter(([_, value]: [string, string]) => value !== undefined)
            .map(
                ([variable, value]: [string, string]) => {
                    return [variable, expandEnvVars(value)];
                },
            ),
        ),
    };
    let entrypoint = composeData.entrypoint;
    if (entrypoint && typeof entrypoint === 'string') {
        entrypoint = splitShellString(entrypoint);
    }
    if (entrypoint && Array.isArray(entrypoint)) {
        entrypoint = entrypoint.map(expandEnvVars);
    }
    let cmd = composeData.command;
    if (cmd && typeof cmd === 'string') {
        cmd = splitShellString(cmd);
    }
    if (cmd && Array.isArray(cmd)) {
        cmd = cmd.map(expandEnvVars);
    }
    const services = (composeData.ports ?? []).concat(metadata?.extraPorts ?? []).map((portMapping: string) => {
        let [hostPort, containerPort, protocol] = portMapping.match(
            /([^:]+):([^\/]+)(?:\/(.*))?/
        )?.slice(1) ?? [undefined, undefined, undefined];
        if (hostPort === undefined || containerPort === undefined) {
            throw new Error(`Invalid port mapping: ${portMapping}`);
        }
        if (metadata?.suppressPorts?.includes(hostPort)) {
            console.warn(`Suppressing port ${hostPort} for ${name}`);
            return;
        }
        const isRawPort = metadata?.rawPorts?.includes(hostPort);
        hostPort = expandEnvVars(hostPort);
        containerPort = expandEnvVars(containerPort);

        return {
            internal_port: containerPort,
            protocol: protocol ?? "tcp",
            auto_stop_machines: "off",
            auto_start_machines: true,
            min_machines_running: 1,
            ports: [
                {
                    ...(!isRawPort) && { handlers: ["http"] },
                    port: isRawPort ? hostPort : 80,
                    force_https: !isRawPort
                },
                ...(!isRawPort) && [{
                    handlers: ["tls", "http"],
                    port: 443,
                }] || []
            ]
        }
    })
    .filter((service: any) => service !== undefined);
    const dockerVolumes =
        (composeData.volumes ?? []).concat(metadata?.extraVolumes ?? [])
    .map((volume: string) => {
        const [hostPath, containerPath, mode] = expandEnvVars(volume).split(":");
        const fileStat = fs.statSync(dockerDir+hostPath, { throwIfNoEntry: false });
        if (fileStat?.isSocket())
            console.warn(`Warning: ${hostPath} is a socket file. Ignoring.`);
        if (fileStat?.isFIFO())
            console.warn(`Warning: ${hostPath} is a FIFO file. Ignoring.`);
        return {
            hostPath,
            containerPath,
            mode,
            isDir: !(fileStat?.isFile() || fileStat?.isSocket() || fileStat?.isFIFO()),
            isFile: fileStat?.isFile()
         };
    });
    const files = dockerVolumes
    .filter((volume: any) => volume.isFile)
    .map((volume: any) => {
        if (volume.mode === "z")
            throw new Error('Mode "z" not supported for files.');
        const targetPath = `${dir}/${volume.hostPath}`;
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        try {
            fs.copyFileSync(dockerDir+volume.hostPath, targetPath);
        }
        catch (error) {
            console.error(`Failed to copy ${volume.hostPath} to ${targetPath}: ${error.message}`);
        }
        return {
            guest_path: volume.containerPath,
            local_path: volume.hostPath,
        }
    });
    let mounts = dockerVolumes
    .filter((volume: any) => volume.isDir)
    .filter((volume: any) => {
        if (metadata?.skipVolumes?.includes(volume.hostPath)) {
            console.warn(`Skipping volume ${volume.hostPath} for ${name}`);
            return false;
        }
        return true;
    })
    .map((volume: any) => {
        if (volume.mode === "z") {
            console.warn(`Sharing of volumes between apps is currently not supported. Creating separate volumes for ${volume.hostPath}.`);
        }

        const volumeName = `${prefix}_${volume.hostPath
        .replace(/^.\/volumes\//, '')
        .replace(/[^a-z0-9]/gi, '_')}`;

        if (fs.statSync(dockerDir + volume.hostPath, { throwIfNoEntry: false })?.isDirectory()) {
            const targetPath = `${dir}/${volume.hostPath}`;
            fs.mkdirSync(targetPath, { recursive: true });
            fs.cpSync(dockerDir + volume.hostPath, targetPath, { recursive: true });
            fs.readdirSync(targetPath, { recursive: true, withFileTypes: true }).forEach((entry) => {
                if (entry.isFile()) {
                    const relativePath = path.relative(targetPath, path.join(entry.parentPath, entry.name));
                    files.push({
                        guest_path: `${volume.containerPath}/${relativePath}`,
                        local_path: `${volume.hostPath}/${relativePath}`,
                    });
                }
            });
        }

        return {
            destination: volume.containerPath,
            source: volumeName,
        }
    });

    if (metadata?.buildFromRepo && metadata?.image) {
        if (execSync(`docker images -q ${metadata.image}`, { encoding: 'utf-8' }) !== '') {
            console.log(`Image ${metadata.image} already exists. Skipping build.`);
        } else {
            console.log(`Building image for ${name} from repo`);
            const { repo, branch, dockerfile } = metadata.buildFromRepo;
            const buildDir = `${dir}/repo`;
            fs.rmSync(buildDir, { recursive: true, force: true });
            fs.mkdirSync(buildDir, { recursive: true });
            execSync(`git clone -c advice.detachedHead=false --depth 1 -b ${branch} ${repo} ${buildDir}`, { stdio: 'inherit' });
            execSync(`docker build -t ${metadata.image} ${buildDir}`, { stdio: 'inherit' });
        }
    }

    let image = metadata?.image ?? composeData.image;
    let needCustomImage = false;
    if (mounts.length > 0) {
        console.warn(`Volume mounts detected for '${name}'. Creating custom image.`);
        needCustomImage = true;
    }
    if (metadata?.extraContainerSetup) {
        console.warn(`Extra setup detected for '${name}'. Creating custom image.`);
        needCustomImage = true;
    }
    if (needCustomImage) {
        ({ mounts, entrypoint } = generateDockerfile(image, entrypoint, composeData, dir, mounts, prefix, name, metadata));
        image = null;
    }

    (metadata?.postprocess ?? []).forEach((postprocess: any) => {
        postprocess(context);
    });

    const secrets = metadata?.secrets;
    if (secrets) {
        console.log(`Making secrets.sh for ${name}`);
        const secretsSh = fs.openSync(`${dir}/secrets.sh`, 'w');
        fs.writeSync(secretsSh, '#!/bin/sh\n');
        const expandedSecrets: string[] = [];
        for (const secretName in secrets) {
            let secretValue = secrets[secretName];
            if (secretValue === true)
                secretValue = composeData.environment[secretName];
            const secretValueExpanded = expandEnvVars(secretValue);
            expandedSecrets.push(`${secretName}=${secretValueExpanded}`);
        }
        fs.writeSync(secretsSh, `fly secrets import --stage -a ${prefix}-${name} <<EOF\n`);
        fs.writeSync(secretsSh, [...expandedSecrets, 'EOF', ''].join('\n'));
        fs.closeSync(secretsSh);
        fs.chmodSync(`${dir}/secrets.sh`, 0o755);
    }

    fs.writeFileSync(`${dir}/deploy.sh`, dedent`
        #!/bin/sh
        set -o errexit

        if ! fly status --app ${prefix}-${name} &>/dev/null; then
            fly apps create --org ${org} --name ${prefix}-${name}
        fi
        ${(() => {
            if ((metadata?.image ?? '').startsWith('registry.fly.io/'))
                return dedent`
                    docker push ${metadata.image}
                    \n`;
            return '';
        })()}
        [ -e secrets.sh ] && ./secrets.sh
        fly deploy --no-public-ips --ha=${metadata?.ha ?? false}
        ${(() => {
            if (metadata?.ip === 'flycast')
                return 'fly ips list | grep v6 || fly ips allocate-v6 --private\n';
            if (services.length > 0)
                return dedent`
                    fly ips list | grep v6 || fly ips allocate-v6
                    fly ips list | grep v4 || fly ips allocate-v4 --shared
                    \n`;
            return '';
        })()}
        ${
            (metadata?.extraDeployment ?? []).map((extraDeployment: any) => {
                return extraDeployment(context);
            }).join('\n')
        }
        \n`);
    fs.chmodSync(`${dir}/deploy.sh`, 0o755);


    const flyConfig = {
        app: `${prefix}-${name}`,
        primary_region: "yul",
        build: {
            ...image
            ? { image }
            : { dockerfile: "Dockerfile" },
        },
        env,
        mounts,
        files,
        services,
        vm: {
            ...defaultVm,
            ...metadata?.vm
        },
        ...entrypoint && { experimental: { entrypoint } },
        ...cmd && { experimental: { cmd } },
    };
    return stringify(flyConfig)+'\n';
}

function generateDockerfile(image: string, entrypoint: string[], composeData: any, dir: string, mounts: any, prefix: string, name: string, metadata: any) {
    const {user, entrypoint: imageEntrypoint, cmd} = getDockerUserEntrypointAndCmd(image);
    const dockerfile = `${dir}/Dockerfile`;
    const fd = fs.openSync(dockerfile, 'w');
    fs.writeSync(fd, dedent`
        FROM ${image}

        USER root
        RUN mkdir -p /fly-data

        COPY --chmod=755 --chown=${user} <<EOF /usr/local/bin/fly-user-entrypoint.sh
        #!/bin/sh
        exec ${singleQuote(imageEntrypoint)} "\\$@"
        EOF

        COPY --chmod=755 <<EOF /usr/local/bin/fly-entrypoint.sh
        #!/bin/sh\n
        `);
    mounts.forEach((mount: any) => {
        fs.writeSync(fd, dedent`
            if [ ! -e /fly-data/${mount.source} ]; then
              if [ -e ${mount.destination} ]; then
                mv ${mount.destination} /fly-data/${mount.source}
              else
                mkdir -p /fly-data/${mount.source}
              fi
            fi
            mkdir -p ${path.dirname(mount.destination)}
            if [ -e ${mount.destination} ]; then
                rm -rf ${mount.destination}
            fi
            ln -s /fly-data/${mount.source} ${mount.destination}\n
            `);
    });

    if (metadata?.extraContainerSetup)
        fs.writeSync(fd, '\n'+metadata.extraContainerSetup+'\n');

    if (user !== 'root') {
        fs.writeSync(fd, `exec su \\$(id -u -n ${user}) /usr/local/bin/fly-user-entrypoint.sh "\\$@"\n`);
    }
    else {
        fs.writeSync(fd, `exec /usr/local/bin/fly-user-entrypoint.sh "\\$@"\n`);
    }
    fs.writeSync(fd, dedent`
        EOF

        # only for local development, ignored by fly.io
        VOLUME [ "/fly-data" ]

        ENTRYPOINT ["fly-entrypoint.sh"]\n
        `);
    if (cmd) {
        fs.writeSync(fd, `CMD ${JSON.stringify(cmd)}\n`);
    }
    fs.closeSync(fd);
    mounts = [{
        destination: "/fly-data",
        source: `${prefix}_${name}_data`,
    }];
    const newEntrypoint = entrypoint
    ? [
        "/usr/local/bin/fly-entrypoint.sh",
        ...entrypoint,
    ]
    : undefined;
    return { mounts, entrypoint: newEntrypoint };
}

function postprocessKongYml(context: { prefix: string; dir: string }) {
    const { prefix, dir } = context;
    replaceInFileSync({
        files: `${dir}/volumes/api/kong.yml`,
        from: [ /realtime-dev\.supabase-realtime/g, /http:\/\/(.*):/g, new RegExp(String.raw`${prefix}-functions.internal`, "g") ],
        to: [ 'realtime', `http://${prefix}-$1.internal:`, `${prefix}-functions.flycast` ],
    });
}

function makeFlyLogShipperConfig() {
    const composeYaml = fs.readFileSync("./supabase/docker/volumes/logs/vector.yml", "utf8");
    const composeData = parse(composeYaml);

    const transforms = { ...composeData.transforms };
    transforms.project_logs.inputs = [ "log_json" ];
    transforms.project_logs.source = transforms.project_logs.source.replace('.container_name', '.fly.app.name');
    transforms.router.route = Object.fromEntries(
        Object.entries<string>(transforms.router.route)
        .map(([key, value] : [string, string]) =>
            [key, value.replace('supabase', '${SUPABASE_PREFIX}')])
    );
    const sinks = Object.fromEntries(
        Object.entries(composeData.sinks)
        .map(([sinkName, sinkDefinition]: [string, any]) =>
            [sinkName, {
                ...sinkDefinition,
                auth: {
                    strategy: "bearer",
                    token: "${SUPABASE_LOGFLARE_API_KEY}",
                },
                uri: sinkDefinition.uri
                    .replace(/.*\/api\/logs/, '${SUPABASE_LOGFLARE_URL}')
                    .replace(/&api_key=.*$/, '')
            }])
    );
    transforms.rest_logs.source = dedent`
        parsed, err = parse_regex(.event_message, r'\[(?P<time>.*)\] (?P<msg>.*)$')
        if err == null {
          .event_message = parsed.msg
          .timestamp = to_timestamp!(parsed.time)
          .metadata.host = .project
        }\n
        `;

    const flyConfig = {
        transforms,
        sinks
    }
    fs.mkdirSync("./supabase/docker/volumes/fly-log-shipper", { recursive: true });
    fs.writeFileSync("./supabase/docker/volumes/fly-log-shipper/supabase.toml", stringify(flyConfig).replaceAll('\\', '\\\\')+'\n');
}

function makeRealtimeTenantSetup(context: {prefix: string, name: string, dir: string}) {
    const { prefix, name, dir } = context;
    fs.copyFileSync('./.env', `${dir}/.env`);
    fs.copyFileSync('./makeRealtimeTenant.ts', `${dir}/makeRealtimeTenant.ts`);
    return dedent`
        ./makeRealtimeTenant.ts ${prefix}-${name}
        `;
}

function makeDependencyGraph(composeData: any, metadata: Metadata): { [key: string]: string[] } {
    const graph: { [key: string]: string[] } = {};

    for (const serviceName in composeData.services) {
        const service = composeData.services[serviceName];
        if (serviceName in substitutedServices) {
            continue;
        }
        const dependencies: string[] = [];

        if (service.depends_on) {
            dependencies.push(...Object.keys(service.depends_on));
        }
        if (metadata[serviceName]?.extraDependsOn) {
            dependencies.push(...metadata[serviceName].extraDependsOn);
        }
        graph[serviceName] = dependencies.map((dependency: string) =>
            substitutedServices[dependency] ?? dependency
        );
    }

    return graph;
}

function clone() {
    if (fs.existsSync('supabase')) {
        console.log('Supabase repo already exists. Skipping clone.');
        return;
    }
    execSync(`git clone --filter=blob:none --no-checkout ${baseRepo} supabase`, { stdio: 'inherit' });
    execSync(`git sparse-checkout set --cone docker`, { stdio: 'inherit', cwd: 'supabase' });
    execSync(`git checkout ${baseBranch}`, { stdio: 'inherit', cwd: 'supabase' });
}

function checkJwt() {
    try {
        verify(process.env.ANON_KEY, process.env.JWT_SECRET);
        verify(process.env.SERVICE_ROLE_KEY, process.env.JWT_SECRET);
    } catch (error) {
        console.log('JWT_SECRET does not match ANON_KEY or SERVICE_ROLE_KEY: regenerating keys.');
        const now = Math.floor(Date.now() / 1000);
        const fiveYears = 5 * 365 * 24 * 60 * 60;
        process.env.ANON_KEY = sign({
            "role": "anon",
            "iss": "supabase",
            "iat": now,
            "exp": now + fiveYears
        }, process.env.JWT_SECRET);
        process.env.SERVICE_ROLE_KEY = sign({
            "role": "service_role",
            "iss": "supabase",
            "iat": now,
            "exp": now + fiveYears
        }, process.env.JWT_SECRET);
        replaceInFileSync({
            files: './.env',
            from: [ /ANON_KEY=.*(?:\n|$)/, /SERVICE_ROLE_KEY=.*(?:\n|$)/ ],
            to: [ `ANON_KEY=${process.env.ANON_KEY}\n`, `SERVICE_ROLE_KEY=${process.env.SERVICE_ROLE_KEY}\n` ]
        });
    }
}

function setupEnvironment(prefix: string) {
    process.env.POSTGRES_HOST = `${prefix}-db.internal`;
    process.env.API_EXTERNAL_URL = `https://${prefix}-kong.fly.dev`;
    process.env.SUPABASE_PUBLIC_URL = `https://${prefix}-kong.fly.dev`;
}

function checkLogShipperAccessKey() {
    if (!process.env.FLY_LOG_SHIPPER_ACCESS_KEY) {
        console.log('Generating new FLY_LOG_SHIPPER_ACCESS_KEY.');
        const token = JSON.parse(execSync(`flyctl tokens create readonly -j -n "Log shipper for supabase" ${org}`, { encoding: 'utf8' }));
        process.env.FLY_LOG_SHIPPER_ACCESS_KEY = token.token;
        replaceInFileSync({
            files: './.env',
            from: /FLY_LOG_SHIPPER_ACCESS_KEY=.*(?:\n|$)/,
            to: `FLY_LOG_SHIPPER_ACCESS_KEY=${token.token}\n`
        });
    }
}

function setup() {
    clone();
    fs.cpSync('./data/', './supabase/docker/', { recursive: true });
    checkJwt();
    checkLogShipperAccessKey();
}

async function main() {
    setup();

    if (!fs.existsSync('./.env')) {
        console.log('Please create a .env file with the required environment variables (see .env.example).');
        process.exit(1);
    }

    const composeYaml = fs.readFileSync("./supabase/docker/docker-compose.yml", "utf8");
    const composeData = parse(composeYaml);
    const prefix = process.env.FLY_PREFIX || composeData.name || 'supabase';

    setupEnvironment(prefix);
    const metadata = makeMetadata(prefix, composeData);

    Object.assign(composeData.services, extraServices);

    const flyDir = "./fly";

    // "recursive: true" to ignore error if already exists
    fs.mkdirSync(flyDir, { recursive: true });

    for (const serviceName in composeData.services) {
        if (serviceName in substitutedServices) {
            console.log(`Skipping ${serviceName}`);
            continue;
        }
        console.log(`Making fly.toml for ${serviceName}`);
        const service = composeData.services[serviceName];
        const flyTomlDir = `${flyDir}/${serviceName}`;
        fs.mkdirSync(flyTomlDir, { recursive: true });
        const flyToml = makeFly({prefix, name: serviceName, composeData: service, dir: flyTomlDir, metadata: metadata[serviceName]});
        const flyTomlPath = `${flyTomlDir}/fly.toml`;
        fs.writeFileSync(flyTomlPath, flyToml);
    }

    const dependencyGraph = makeDependencyGraph(composeData, metadata);
    // console.log(JSON.stringify(dependencyGraph, null, 2));
    const appOrder = solveDependencies(dependencyGraph);

    const deployAllSh = fs.openSync(`${flyDir}/deploy-all.sh`, 'w');
    fs.writeSync(deployAllSh, dedent`
        #!/bin/sh
        set -o errexit\n\n
        `);
    appOrder.forEach((serviceName: string) => {
        fs.writeSync(deployAllSh, dedent`
            echo -e "\\n>>> Deploying ${serviceName}"
            pushd ${serviceName} &>/dev/null
            ./deploy.sh
            popd &>/dev/null\n\n
            `);
    });
    fs.writeSync(deployAllSh, dedent`
        cat <<EOF
        >>> All apps deployed!
        Find your supabase studio at: https://${prefix}-kong.fly.dev
        EOF
        \n`);
    fs.closeSync(deployAllSh);
    fs.chmodSync(`${flyDir}/deploy-all.sh`, 0o755);

    const destroyAllSh = fs.openSync(`${flyDir}/destroy-all.sh`, 'w');
    fs.writeSync(destroyAllSh, dedent`
        #!/bin/sh
        set -o errexit

        cat <<EOF
        ** This will tear down the complete supabase deployment and **
        ** DELETE all volumes with all DATA!                        **

        The prefix is: "${prefix}"

        EOF
        read -p "Please enter the prefix to proceed (anything else will quit): " -r
        if [[ "$REPLY" != "${prefix}" ]];
        then
            exit 0
        fi

        `);
    appOrder.reverse().forEach((serviceName: string) => {
        fs.writeSync(destroyAllSh, dedent`
            echo -e "\\n>>> Destroying ${serviceName}"
            fly apps destroy ${prefix}-${serviceName} --yes || true
            \n`);
    });
    fs.closeSync(destroyAllSh);
    fs.chmodSync(`${flyDir}/destroy-all.sh`, 0o755);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(`Failed.\n${error.stack}`);
        process.exit(1);
    });

#!/bin/env -S npx tsx

import { parse } from "yaml";
import * as fs from "node:fs";
import { stringify } from "smol-toml";
import * as dotenv from "dotenv";
import "dotenv/config";
import { splitShellString } from "./splitShellString";
import * as path from "path";
import { execSync } from "node:child_process";
import { replaceInFileSync } from "replace-in-file";
import dedent from "ts-dedent";
import { solve as solveDependencies } from "dependency-solver";
import { sign, verify } from "jsonwebtoken";
import { expandEnvVars } from "./expandEnvVars";

const baseRepo = "https://github.com/supabase/supabase.git";
const baseBranch = "1.25.04";

const org = process.env.FLY_ORG || "personal";

const defaultVm = {
  memory: "1GB",
};

const dockerDir = "./supabase/docker/";

type FlyConfig = {
  app: string;
  primary_region: string;
  build:
    | {
        image: string;
      }
    | {
        dockerfile: string;
      };
  env: Record<string, string>;
  mounts: Array<{ destination: string; source: string }>;
  files: Array<{ guest_path: string; local_path: string }>;
  services: Array<any>;
  vm: Record<string, any>;
  experimental?: {
    entrypoint?: string[];
    cmd?: string[];
  };
};

type InputContext = {
  prefix: string;
  name: string;
  composeData: any;
  dir: string;
  metadata: any;
};

type Context = InputContext & {
  flyConfig: FlyConfig;
};

type ServiceMetadata = {
  image?: string;
  buildFromRepo?: { repo: string; branch: string; dockerfile?: string };
  ha: boolean;
  env?: { [key: string]: string | number | boolean | undefined };
  secrets?: { [key: string]: true | string };
  suppressPorts?: string[];
  rawPorts?: string[];
  extraPorts?: string[];
  ip?: "flycast";
  extraVolumes?: string[];
  extraDependsOn?: string[];
  skipVolumes?: string[];
  vm?: any;
  postprocess?: ((context: Context) => void)[];
  preprocess?: ((context: InputContext) => void)[];
  extraDeployment?: ((context: Context) => string)[];
  extraContainerSetup?: string;
};

type Metadata = {
  [key: string]: ServiceMetadata;
};

function makeMetadata(prefix: string): Metadata {
  return {
    db: {
      ha: false,
      extraPorts: ["${POSTGRES_PORT}:${POSTGRES_PORT}"],
      rawPorts: ["${POSTGRES_PORT}"],
    },
    auth: {
      ha: true,
    },
    kong: {
      ha: true,
      suppressPorts: ["${KONG_HTTPS_PORT}"],
      env: {
        KONG_DNS_ORDER: "LAST,AAAA,A,CNAME",
      },
      postprocess: [postprocessKongYml],
    },
    meta: {
      ha: true,
      env: {
        PG_META_HOST: "fly-local-6pn",
      },
    },
    studio: {
      ha: true,
      env: {
        HOSTNAME: "fly-local-6pn",
        SUPABASE_URL: `https://${prefix}-kong.fly.dev`,
        NEXT_PUBLIC_SITE_URL: `https://${prefix}-kong.fly.dev`,
        NEXT_PUBLIC_GOTRUE_URL: `https://${prefix}-kong.fly.dev/auth/v1`,
      },
    },
    analytics: {
      ha: true,
      buildFromRepo: {
        repo: "https://github.com/tvogel/logflare.git",
        branch: "v1.8.11-tv-1",
      },
      env: {
        LOGFLARE_NODE_HOST: `${prefix}-analytics.fly.dev`,
        LOGFLARE_API_KEY: undefined,
        LOGFLARE_LOG_LEVEL: "warn",
        PHX_HTTP_IP: "::",
        PHX_URL_HOST: `${prefix}-analytics.fly.dev`,
      },
      secrets: {
        POSTGRES_BACKEND_URL: true,
        LOGFLARE_PUBLIC_ACCESS_TOKEN: "${LOGFLARE_API_KEY}",
      },
    },
    rest: {
      ha: true,
      env: {
        PGRST_SERVER_HOST: "fly-local-6pn",
        PGRST_LOG_LEVEL: "${PGRST_LOG_LEVEL}",
      },
      secrets: {
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
        AWS_ACCESS_KEY_ID: "${STORAGE_AWS_ACCESS_KEY_ID}",
        AWS_SECRET_ACCESS_KEY: "${STORAGE_AWS_SECRET_ACCESS_KEY}",
      },
      skipVolumes: ["./volumes/storage"],
      extraDependsOn: ["minio"],
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
        AWS_ACCESS_KEY_ID: "${STORAGE_AWS_ACCESS_KEY_ID}",
        AWS_SECRET_ACCESS_KEY: "${STORAGE_AWS_SECRET_ACCESS_KEY}",
      },
      skipVolumes: ["./volumes/storage"],
    },
    realtime: {
      ha: false,
      buildFromRepo: {
        repo: "https://github.com/tvogel/realtime.git",
        branch: "v2.30.34-tv-1",
      },
      env: {
        ERL_AFLAGS: "-proto_dist inet6_tcp",
        SEED_SELF_HOST: 0,
      },
      // extraVolumes: [ "./volumes/realtime/runtime.exs:/app/releases/2.28.32/runtime.exs" ],
      extraDeployment: [makeRealtimeTenantSetup],
    },
    functions: {
      ha: true,
      env: {
        SUPABASE_URL: `https://${prefix}-kong.fly.dev`,
      },
      secrets: {
        SUPABASE_DB_URL: true,
      },
      extraPorts: ["9000:9000"],
      rawPorts: ["9000"],
      ip: "flycast",
      postprocess: [installEdgeFunctions],
      extraDeployment: [installDeployFunctions],
    },
    minio: {
      ha: false,
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
        ACCESS_TOKEN: "${FLY_LOG_SHIPPER_ACCESS_KEY}",
        SUPABASE_LOGFLARE_API_KEY: "${LOGFLARE_API_KEY}",
      },
      preprocess: [makeFlyLogShipperConfig],
    },
    supavisor: {
      ha: false,
      rawPorts: ["${POSTGRES_PORT}", "${POOLER_PROXY_PORT_TRANSACTION}"],
    },
  };
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
    ports: ["9001:9001"],
    volumes: ["./volumes/minio:/minio-data"],
    command: ["server", "/minio-data", "--console-address", ":9001"],
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
    },
  },
};

function getDockerUserEntrypointAndCmd(image: string) {
  execSync(`docker pull ${image}`, { stdio: "inherit" });
  const dockerInspect = JSON.parse(
    execSync(`docker inspect -f json ${image}`, { encoding: "utf8" })
  );
  const user = dockerInspect[0].Config.User || "root";
  const entrypoint = dockerInspect[0].Config.Entrypoint;
  const cmd = dockerInspect[0].Config.Cmd;
  return { user, entrypoint, cmd };
}

function singleQuote(args: string[]): string {
  if (!args || args.length === 0) return "";
  return "'" + args.map((arg) => arg.replace(/'/g, "\\'")).join("' '") + "'";
}

function doubleQuote(args: string[]): string {
  if (!args || args.length === 0) return "";
  return '"' + args.map((arg) => arg.replace(/"/g, '\\"')).join('" "') + '"';
}

function toVolumeName(volume: string): string {
  return volume.replace(/[^a-z0-9_]/gi, "_");
}

function addFile(
  context: Context,
  localPath: string,
  stagingPath: string,
  containerPath: string
): void {
  if (!fs.statSync(localPath, { throwIfNoEntry: false })?.isFile()) {
    return;
  }

  const { dir, flyConfig } = context;
  const fullStagingPath = `${dir}/${stagingPath}`;
  fs.mkdirSync(path.dirname(fullStagingPath), { recursive: true });
  try {
    fs.copyFileSync(localPath, fullStagingPath);
  } catch (error) {
    console.error(
      `Failed to copy ${localPath} to ${fullStagingPath}: ${error.message}`
    );
    throw error;
  }

  flyConfig.files.push({
    local_path: stagingPath,
    guest_path: containerPath,
  });
}

function makeFly(inputContext: {
  prefix: string;
  name: string;
  composeData: any;
  dir: string;
  metadata: ServiceMetadata;
}): string {
  const { prefix, name, composeData, dir, metadata } = inputContext;

  (metadata?.preprocess ?? []).forEach((preprocess) => {
    preprocess(inputContext);
  });

  const flyConfig: FlyConfig = {
    app: `${prefix}-${name}`,
    primary_region: process.env.FLY_REGION || "fra",
    build: {
      image: metadata?.image ?? composeData.image,
    },
    env: {},
    mounts: [],
    files: [],
    services: [],
    vm: {
      ...defaultVm,
      ...metadata?.vm,
    },
  };

  const context: Context = {
    ...inputContext,
    flyConfig,
  };

  function mapUnqualifiedUrl(value: string): string {
    try {
      const url = new URL(value);
      const origName = url.hostname;
      if (url.hostname !== "localhost") {
        // allow dev-redirects to localhost
        url.hostname = origName.replace(/^([^.]+)$/, `${prefix}-$1.internal`);
      }
      if (url.hostname === origName) return value;
      const newUrl = url.toString();
      if (!value.endsWith("/") && newUrl.endsWith("/"))
        return newUrl.slice(0, -1);
      return newUrl;
    } catch (error) {
      // Not a URL
    }
    return value;
  }

  function guessSecret(key: string): boolean {
    return !!key.match(/(pass|secret|key|database_url)/i);
  }

  const guessedSecrets = Object.keys(composeData.environment).filter(
    (key: string) => guessSecret(key)
  );

  flyConfig.env = {
    ...Object.fromEntries(
      Object.entries<string>({
        ...composeData.environment,
        ...metadata?.env,
      })
        .filter(([_, value]: [string, string]) => value !== undefined)
        .filter(
          ([key, _]: [string, string]) =>
            !guessedSecrets.includes(key) &&
            metadata?.secrets?.[key] === undefined
        )
        .map(([variable, value]: [string, string]) => {
          return [variable, mapUnqualifiedUrl(expandEnvVars(value))];
        })
    ),
  };
  if (composeData.entrypoint) {
    let entrypoint = composeData.entrypoint;
    if (typeof entrypoint === "string") {
      entrypoint = splitShellString(entrypoint);
    }
    if (Array.isArray(entrypoint)) {
      entrypoint = entrypoint.map(expandEnvVars);
    }
    flyConfig.experimental = {
      ...flyConfig.experimental,
      entrypoint,
    };
  }

  if (composeData.command) {
    let cmd = composeData.command;
    if (typeof cmd === "string") {
      cmd = splitShellString(cmd);
    }
    if (Array.isArray(cmd)) {
      cmd = cmd.map(expandEnvVars);
    }
    flyConfig.experimental = {
      ...flyConfig.experimental,
      cmd,
    };
  }
  flyConfig.services = (composeData.ports ?? [])
    .concat(metadata?.extraPorts ?? [])
    .map((portMapping: string) => {
      let [hostPort, containerPort, protocol] = portMapping
        .match(/([^:]+):([^\/]+)(?:\/(.*))?/)
        ?.slice(1) ?? [undefined, undefined, undefined];
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
            ...(!isRawPort && { handlers: ["http"] }),
            port: isRawPort ? hostPort : 80,
            force_https: !isRawPort,
          },
          ...((!isRawPort && [
            {
              handlers: ["tls", "http"],
              port: 443,
            },
          ]) ||
            []),
        ],
      };
    })
    .filter((service: any) => service !== undefined);
  const dockerVolumes = (composeData.volumes ?? [])
    .concat(metadata?.extraVolumes ?? [])
    .map((volume: string) => {
      const [hostPath, containerPath, mode] = expandEnvVars(volume).split(":");
      const fileStat = fs.statSync(dockerDir + hostPath, {
        throwIfNoEntry: false,
      });
      if (fileStat?.isSocket())
        console.warn(`Warning: ${hostPath} is a socket file. Ignoring.`);
      if (fileStat?.isFIFO())
        console.warn(`Warning: ${hostPath} is a FIFO file. Ignoring.`);
      return {
        hostPath,
        containerPath,
        mode,
        isDir: !(
          fileStat?.isFile() ||
          fileStat?.isSocket() ||
          fileStat?.isFIFO()
        ),
        isFile: fileStat?.isFile(),
      };
    });
  dockerVolumes
    .filter((volume: any) => volume.isFile)
    .forEach((volume: any) => {
      if (volume.mode === "z")
        throw new Error('Mode "z" not supported for files.');
      addFile(
        context,
        dockerDir + volume.hostPath,
        volume.hostPath,
        volume.containerPath
      );
    });
  flyConfig.mounts = dockerVolumes
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
        console.warn(
          `Sharing of volumes between apps is currently not supported. Creating separate volumes for ${volume.hostPath}.`
        );
      }

      const volumeName = toVolumeName(
        `${prefix}_${volume.hostPath.replace(/^.\/volumes\//, "")}`
      );

      if (
        fs
          .statSync(dockerDir + volume.hostPath, { throwIfNoEntry: false })
          ?.isDirectory()
      ) {
        const targetPath = `${dir}/${volume.hostPath}`;
        fs.mkdirSync(targetPath, { recursive: true });
        fs.readdirSync(dockerDir + volume.hostPath, {
          recursive: true,
          encoding: "utf8",
        }).forEach((entry) => {
          addFile(
            context,
            `${dockerDir + volume.hostPath}/${entry}`,
            `${volume.hostPath}/${entry}`,
            `${volume.containerPath}/${entry}`
          );
        });
      }

      return {
        destination: volume.containerPath,
        source: volumeName,
      };
    });

  if (metadata?.buildFromRepo) {
    if (metadata.image)
      throw new Error("Cannot specify both image and buildFromRepo");
    metadata.image = `registry.fly.io/${prefix}-${name}:${metadata.buildFromRepo.branch}`;
    if (
      execSync(`docker images -q ${metadata.image}`, { encoding: "utf-8" }) !==
      ""
    ) {
      console.log(`Image ${metadata.image} already exists. Skipping build.`);
    } else {
      console.log(`Building image for ${name} from repo`);
      const { repo, branch, dockerfile } = metadata.buildFromRepo;
      const buildDir = `${dir}/repo`;
      fs.rmSync(buildDir, { recursive: true, force: true });
      fs.mkdirSync(buildDir, { recursive: true });
      execSync(
        `git clone -c advice.detachedHead=false --depth 1 -b ${branch} ${repo} ${buildDir}`,
        { stdio: "inherit" }
      );
      execSync(`docker build -t ${metadata.image} ${buildDir}`, {
        stdio: "inherit",
      });
    }
    flyConfig.build = {
      image: metadata.image,
    };
  }

  let needCustomImage = false;
  if (flyConfig.mounts.length > 0) {
    console.warn(
      `Volume mounts detected for '${name}'. Creating custom image.`
    );
    needCustomImage = true;
  }
  if (metadata?.extraContainerSetup) {
    console.warn(`Extra setup detected for '${name}'. Creating custom image.`);
    needCustomImage = true;
  }
  if (needCustomImage && "image" in flyConfig.build /* for TS, always true */) {
    const { mounts, entrypoint } = generateDockerfile(
      flyConfig.build.image,
      flyConfig.experimental?.entrypoint,
      composeData,
      dir,
      flyConfig.mounts,
      prefix,
      name,
      metadata
    );
    flyConfig.mounts = mounts;
    if (entrypoint) {
      flyConfig.experimental = {
        ...flyConfig.experimental,
        entrypoint,
      };
    }
    flyConfig.build = {
      dockerfile: "Dockerfile",
    };
  }

  (metadata?.postprocess ?? []).forEach((postprocess: any) => {
    postprocess(context);
  });

  const secrets = {
    ...Object.fromEntries(guessedSecrets.map((key: string) => [key, true])),
    ...metadata?.secrets,
  };
  if (Object.keys(secrets).length > 0) {
    console.log(`Making secrets.sh for ${name}`);
    const secretsSh = fs.openSync(`${dir}/secrets.sh`, "w");
    fs.writeSync(secretsSh, "#!/bin/sh\n");
    const expandedSecrets: string[] = [];
    for (const secretName in secrets) {
      let secretValue = secrets[secretName];
      if (secretValue === true)
        secretValue = composeData.environment[secretName];
      const secretValueExpanded = mapUnqualifiedUrl(expandEnvVars(secretValue));
      expandedSecrets.push(`${secretName}=${secretValueExpanded}`);
    }
    fs.writeSync(
      secretsSh,
      `fly secrets import --stage -a ${prefix}-${name} <<'EOF'\n`
    );
    fs.writeSync(secretsSh, [...expandedSecrets, "EOF", ""].join("\n"));
    fs.closeSync(secretsSh);
    fs.chmodSync(`${dir}/secrets.sh`, 0o755);
  }

  fs.writeFileSync(
    `${dir}/deploy.sh`,
    dedent`
        #!/bin/sh
        set -o errexit

        if ! fly status --app ${prefix}-${name} &>/dev/null; then
            fly apps create --org ${org} --name ${prefix}-${name}
        fi
        ${(() => {
          if ((metadata?.image ?? "").startsWith("registry.fly.io/"))
            return dedent`
                    docker push ${metadata.image}
                    \n`;
          return "";
        })()}
        [ -e secrets.sh ] && ./secrets.sh
        fly deploy --no-public-ips --ha=${metadata?.ha ?? false}
        ${(() => {
          if (metadata?.ip === "flycast")
            return "fly ips list | grep v6 || fly ips allocate-v6 --private\n";
          if (flyConfig.services.length > 0)
            return dedent`
                    fly ips list | grep v6 || fly ips allocate-v6
                    fly ips list | grep v4 || fly ips allocate-v4 --shared
                    \n`;
          return "";
        })()}
        ${(metadata?.extraDeployment ?? [])
          .map((extraDeployment: any) => {
            return extraDeployment(context);
          })
          .join("\n")}
        \n`
  );
  fs.chmodSync(`${dir}/deploy.sh`, 0o755);

  return stringify(flyConfig) + "\n";
}

function generateDockerfile(
  image: string,
  entrypoint: string[],
  composeData: any,
  dir: string,
  mounts: any,
  prefix: string,
  name: string,
  metadata: any
) {
  const {
    user,
    entrypoint: imageEntrypoint,
    cmd,
  } = getDockerUserEntrypointAndCmd(image);
  const dockerfile = `${dir}/Dockerfile`;
  const fd = fs.openSync(dockerfile, "w");
  fs.writeSync(
    fd,
    dedent`
        FROM ${image}

        USER root
        RUN mkdir -p /fly-data

        COPY --chmod=755 --chown=${user} <<EOF /usr/local/bin/fly-user-entrypoint.sh
        #!/bin/sh
        exec ${singleQuote(imageEntrypoint)} "\\$@"
        EOF

        COPY --chmod=755 <<EOF /usr/local/bin/fly-entrypoint.sh
        #!/bin/sh\n
        `
  );
  mounts.forEach((mount: any) => {
    fs.writeSync(
      fd,
      dedent`
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
            mkdir -p ${mount.destination}
            mount --bind /fly-data/${mount.source} ${mount.destination}\n
            `
    );
  });

  if (metadata?.extraContainerSetup)
    fs.writeSync(fd, "\n" + metadata.extraContainerSetup + "\n");

  if (user !== "root") {
    fs.writeSync(
      fd,
      `exec su \\$(id -u -n ${user}) /usr/local/bin/fly-user-entrypoint.sh "\\$@"\n`
    );
  } else {
    fs.writeSync(fd, `exec /usr/local/bin/fly-user-entrypoint.sh "\\$@"\n`);
  }
  fs.writeSync(
    fd,
    dedent`
        EOF

        # only for local development, ignored by fly.io
        VOLUME [ "/fly-data" ]

        ENTRYPOINT ["fly-entrypoint.sh"]\n
        `
  );
  if (cmd) {
    fs.writeSync(fd, `CMD ${JSON.stringify(cmd)}\n`);
  }
  fs.closeSync(fd);
  mounts = [
    {
      destination: "/fly-data",
      source: toVolumeName(`${prefix}_${name}_data`),
    },
  ];
  const newEntrypoint = entrypoint
    ? ["/usr/local/bin/fly-entrypoint.sh", ...entrypoint]
    : undefined;
  return { mounts, entrypoint: newEntrypoint };
}

function postprocessKongYml(context: { prefix: string; dir: string }) {
  const { prefix, dir } = context;
  replaceInFileSync({
    files: `${dir}/volumes/api/kong.yml`,
    from: [
      /realtime-dev\.supabase-realtime/g,
      /http:\/\/(.*):/g,
      new RegExp(String.raw`${prefix}-functions.internal`, "g"),
    ],
    to: [
      "realtime",
      `http://${prefix}-$1.internal:`,
      `${prefix}-functions.flycast`,
    ],
  });
}

function makeFlyLogShipperConfig() {
  const composeYaml = fs.readFileSync(
    "./supabase/docker/volumes/logs/vector.yml",
    "utf8"
  );
  const composeData = parse(composeYaml);

  const transforms = { ...composeData.transforms };
  transforms.project_logs.inputs = ["log_json"];
  transforms.project_logs.source = transforms.project_logs.source.replace(
    ".container_name",
    ".fly.app.name"
  );
  transforms.router.route = Object.fromEntries(
    Object.entries<string>(transforms.router.route).map(
      ([key, value]: [string, string]) => [
        key,
        value.replace("supabase", "${SUPABASE_PREFIX}"),
      ]
    )
  );
  const sinks = Object.fromEntries(
    Object.entries(composeData.sinks).map(
      ([sinkName, sinkDefinition]: [string, any]) => [
        sinkName,
        {
          ...sinkDefinition,
          auth: {
            strategy: "bearer",
            token: "${SUPABASE_LOGFLARE_API_KEY}",
          },
          uri: sinkDefinition.uri
            .replace(/.*\/api\/logs/, "${SUPABASE_LOGFLARE_URL}")
            .replace(/&api_key=.*$/, ""),
        },
      ]
    )
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
    sinks,
  };
  fs.mkdirSync("./supabase/docker/volumes/fly-log-shipper", {
    recursive: true,
  });
  fs.writeFileSync(
    "./supabase/docker/volumes/fly-log-shipper/supabase.toml",
    stringify(flyConfig).replaceAll("\\", "\\\\") + "\n"
  );
}

function makeRealtimeTenantSetup(context: {
  prefix: string;
  name: string;
  dir: string;
}) {
  const { prefix, name, dir } = context;
  fs.copyFileSync("./.env", `${dir}/.env`);
  fs.copyFileSync("./makeRealtimeTenant.ts", `${dir}/makeRealtimeTenant.ts`);
  return dedent`
        ./makeRealtimeTenant.ts ${prefix}-${name}
        `;
}

function installDeployFunctions(context: {
  prefix: string;
  name: string;
  dir: string;
}) {
  const { prefix, name, dir } = context;
  fs.copyFileSync("./deployFunctions.ts", `${dir}/deployFunctions.ts`);
  return "";
}

async function installEdgeFunctionSecrets(
  functionDir: string,
  metadata: Metadata
) {
  const secretsFile = `${functionDir}/.env`;
  if (!fs.existsSync(secretsFile)) return;
  console.log(`Installing secrets for edge functions from ${functionDir}/.env`);
  const secrets = dotenv.parse(fs.readFileSync(secretsFile));
  metadata.secrets = { ...metadata.secrets, ...secrets };
}

function installEdgeFunctions(context: Context) {
  const { prefix, name, dir, metadata, flyConfig } = context;
  if (!process.env.FUNCTIONS_DIR) {
    console.log("No edge function to deploy. Skipping.");
    return;
  }

  fs.writeFileSync(
    `${dir}/.env`,
    `FUNCTIONS_DIR=${process.env.FUNCTIONS_DIR}\n`
  );

  const functionsDir = path.resolve(process.env.FUNCTIONS_DIR);
  if (!fs.existsSync(functionsDir)) {
    console.error(
      `Functions directory ${functionsDir} does not exist. Skipping.`
    );
    return;
  }
  console.log(`Installing edge functions from ${functionsDir}`);
  fs.readdirSync(functionsDir, {
    encoding: "utf8",
    recursive: true,
  }).forEach((entry) => {
    addFile(
      context,
      `${functionsDir}/${entry}`,
      `./volumes/functions/${entry}`,
      `/home/deno/functions/${entry}`
    );
  });

  installEdgeFunctionSecrets(`${dir}/volumes/functions`, metadata);
}

function makeDependencyGraph(
  composeData: any,
  metadata: Metadata
): { [key: string]: string[] } {
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
    graph[serviceName] = dependencies.map(
      (dependency: string) => substitutedServices[dependency] ?? dependency
    );
  }

  return graph;
}

function clone() {
  if (fs.existsSync("supabase")) {
    console.log("Supabase repo already exists. Skipping clone.");
    return;
  }
  execSync(`git clone --filter=blob:none --no-checkout ${baseRepo} supabase`, {
    stdio: "inherit",
  });
  execSync(`git sparse-checkout set --cone docker`, {
    stdio: "inherit",
    cwd: "supabase",
  });
  execSync(`git checkout ${baseBranch}`, { stdio: "inherit", cwd: "supabase" });
}

function checkJwt() {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is required");
  }
  try {
    verify(process.env.ANON_KEY ?? "", process.env.JWT_SECRET);
    verify(process.env.SERVICE_ROLE_KEY ?? "", process.env.JWT_SECRET);
  } catch (error) {
    console.log(
      "JWT_SECRET does not match ANON_KEY or SERVICE_ROLE_KEY: regenerating keys."
    );
    const now = Math.floor(Date.now() / 1000);
    const fiveYears = 5 * 365 * 24 * 60 * 60;
    process.env.ANON_KEY = sign(
      {
        role: "anon",
        iss: "supabase",
        iat: now,
        exp: now + fiveYears,
      },
      process.env.JWT_SECRET
    );
    process.env.SERVICE_ROLE_KEY = sign(
      {
        role: "service_role",
        iss: "supabase",
        iat: now,
        exp: now + fiveYears,
      },
      process.env.JWT_SECRET
    );
    replaceInFileSync({
      files: "./.env",
      from: [/ANON_KEY=.*(?:\n|$)/, /SERVICE_ROLE_KEY=.*(?:\n|$)/],
      to: [
        `ANON_KEY=${process.env.ANON_KEY}\n`,
        `SERVICE_ROLE_KEY=${process.env.SERVICE_ROLE_KEY}\n`,
      ],
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
    console.log("Generating new FLY_LOG_SHIPPER_ACCESS_KEY.");
    const token = JSON.parse(
      execSync(
        `flyctl tokens create readonly -j -n "Log shipper for supabase" ${org}`,
        { encoding: "utf8" }
      )
    );
    process.env.FLY_LOG_SHIPPER_ACCESS_KEY = token.token;
    replaceInFileSync({
      files: "./.env",
      from: /FLY_LOG_SHIPPER_ACCESS_KEY=.*(?:\n|$)/,
      to: `FLY_LOG_SHIPPER_ACCESS_KEY=${token.token}\n`,
    });
  }
}

function setup() {
  clone();
  fs.cpSync("./data/", "./supabase/docker/", { recursive: true });
  checkJwt();
  checkLogShipperAccessKey();
}

function fixupComposeData(composeData: any) {
  for (const serviceName in composeData.services) {
    const service = composeData.services[serviceName];
    if (Array.isArray(service.environment)) {
      service.environment = Object.fromEntries(
        service.environment.map((entry: string) => {
          const [key, value] = entry.split("=");
          return [key, value];
        })
      );
    }
  }
}

async function main() {
  setup();

  if (!fs.existsSync("./.env")) {
    console.log(
      "Please create a .env file with the required environment variables (see .env.example)."
    );
    process.exit(1);
  }

  const composeYaml = fs.readFileSync(
    "./supabase/docker/docker-compose.yml",
    "utf8"
  );
  const composeData = parse(composeYaml);
  fixupComposeData(composeData);

  const prefix =
    process.env.FLY_PREFIX || String(composeData.name) || "supabase";
  if (prefix.match(/[^a-z0-9-]/)) {
    throw new Error(
      "Invalid prefix. Only lowercase letters, numbers, and hyphens are allowed."
    );
  }

  setupEnvironment(prefix);
  Object.assign(composeData.services, extraServices);

  const metadata = makeMetadata(prefix);

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
    const flyToml = makeFly({
      prefix,
      name: serviceName,
      composeData: service,
      dir: flyTomlDir,
      metadata: metadata[serviceName],
    });
    const flyTomlPath = `${flyTomlDir}/fly.toml`;
    fs.writeFileSync(flyTomlPath, flyToml);
  }

  const dependencyGraph = makeDependencyGraph(composeData, metadata);
  // console.log(JSON.stringify(dependencyGraph, null, 2));
  const appOrder = solveDependencies(dependencyGraph);

  const deployAllSh = fs.openSync(`${flyDir}/deploy-all.sh`, "w");
  fs.writeSync(
    deployAllSh,
    dedent`
        #!/bin/sh
        set -o errexit\n\n
        `
  );
  appOrder.forEach((serviceName: string) => {
    fs.writeSync(
      deployAllSh,
      dedent`
            echo -e "\\n>>> Deploying ${serviceName}"
            pushd ${serviceName} &>/dev/null
            ./deploy.sh
            popd &>/dev/null\n\n
            `
    );
  });
  fs.writeSync(
    deployAllSh,
    dedent`
        cat <<EOF
        >>> All apps deployed!
        Find your supabase studio at: https://${prefix}-kong.fly.dev
        EOF
        \n`
  );
  fs.closeSync(deployAllSh);
  fs.chmodSync(`${flyDir}/deploy-all.sh`, 0o755);

  const destroyAllSh = fs.openSync(`${flyDir}/destroy-all.sh`, "w");
  fs.writeSync(
    destroyAllSh,
    dedent`
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

        `
  );
  appOrder.reverse().forEach((serviceName: string) => {
    fs.writeSync(
      destroyAllSh,
      dedent`
            echo -e "\\n>>> Destroying ${serviceName}"
            fly apps destroy ${prefix}-${serviceName} --yes || true
            \n`
    );
  });
  fs.closeSync(destroyAllSh);
  fs.chmodSync(`${flyDir}/destroy-all.sh`, 0o755);

  fs.copyFileSync("./.env", `${flyDir}/.env`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`Failed.\n${error.stack}`);
    process.exit(1);
  });

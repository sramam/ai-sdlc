// The only module that reads `cloudflare:workers` env. Validated once per isolate.
import { env } from "cloudflare:workers";
import { parseEnv } from "../env";

export const appEnv = () => parseEnv(env);

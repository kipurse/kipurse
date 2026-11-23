// APNs auth self-check: sends to an all-zero device token and prints ONLY status + reason per environment
// (BadDeviceToken = key/team/topic accepted). Never prints the key. Run: node scripts/apns-selftest.mjs (with the service env).
import {createPush,apnsConfigFromEnv} from '../src/v5/push.mjs';
const p=createPush({config:apnsConfigFromEnv(process.env)});console.log(JSON.stringify(await p.selfTest()));

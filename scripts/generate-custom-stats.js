// Regenerates data/vanilla-custom-stats.json from the official vanilla server jar.
// Pass the protocol version mineflayer connects as (settings.js minecraft_version).
// The bot on this repo uses 1.20.4. ViaProxy translates the real server down to that protocol.
//
//   node scripts/generate-custom-stats.js 1.20.4
//
// Downloads the server jar from Mojang's version manifest, checks its sha1, and runs
//   java -DbundlerMainClass=net.minecraft.data.Main -jar server.jar --reports
// then keeps minecraft:custom_stat and minecraft:stat_type from generated/reports/registries.json.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const GENERATED_BY = 'java -DbundlerMainClass=net.minecraft.data.Main -jar server.jar --reports';
const REPORT_FILE = 'generated/reports/registries.json';

const version = process.argv[2];
if (typeof version !== 'string' || version.length === 0) {
    throw new Error('pass the Minecraft version, for example: node scripts/generate-custom-stats.js 1.20.4');
}

const manifest = await (await fetch(MANIFEST)).json();
const listed = manifest.versions.find(v => v.id === version);
if (!listed) throw new Error(`version manifest has no ${version}`);
const versionJson = await (await fetch(listed.url)).json();
const server = versionJson.downloads && versionJson.downloads.server;
if (!server || typeof server.url !== 'string' || typeof server.sha1 !== 'string') {
    throw new Error(`version ${version} has no server download`);
}

const dir = mkdtempSync(join(tmpdir(), 'vanilla-stats-'));
try {
    const jarPath = join(dir, 'server.jar');
    const jarBytes = Buffer.from(await (await fetch(server.url)).arrayBuffer());
    const sha1 = createHash('sha1').update(jarBytes).digest('hex');
    if (sha1 !== server.sha1) throw new Error(`server jar sha1 ${sha1} does not match the manifest ${server.sha1}`);
    writeFileSync(jarPath, jarBytes);
    execFileSync('java', ['-DbundlerMainClass=net.minecraft.data.Main', '-jar', 'server.jar', '--reports'], {
        cwd: dir,
        stdio: 'inherit',
    });
    const registries = JSON.parse(readFileSync(join(dir, REPORT_FILE), 'utf8'));
    const custom = registries['minecraft:custom_stat'];
    const statType = registries['minecraft:stat_type'];
    if (!custom || !custom.entries || !custom.entries['minecraft:time_since_rest']) {
        throw new Error('registries.json has no minecraft:custom_stat / minecraft:time_since_rest');
    }
    if (!statType || !statType.entries || !statType.entries['minecraft:custom']) {
        throw new Error('registries.json has no minecraft:stat_type / minecraft:custom');
    }
    const out = {
        minecraftVersion: version,
        jarSha1: sha1,
        versionManifest: MANIFEST,
        serverJarUrl: server.url,
        generatedBy: GENERATED_BY,
        reportFile: REPORT_FILE,
        registries: {
            'minecraft:custom_stat': custom,
            'minecraft:stat_type': statType,
        },
    };
    const dest = join(dirname(fileURLToPath(import.meta.url)), '../data/vanilla-custom-stats.json');
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
    const rest = custom.entries['minecraft:time_since_rest'].protocol_id;
    const category = statType.entries['minecraft:custom'].protocol_id;
    console.log(`wrote ${dest} version ${version} sha1 ${sha1} time_since_rest protocol_id ${rest} custom category ${category}`);
} finally {
    rmSync(dir, { recursive: true, force: true });
}
